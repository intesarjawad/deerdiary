import { type test as base, expect } from '@playwright/test';
import type { loadModels, ModelNeeds, ModelRole } from '../../src/app/models';
import { openApp } from './app';
import { browserModule } from './browser-module';
import { syntheticModelManifest, syntheticModels } from './models';

const scenarios: { name: string; needs: ModelNeeds; roles: ModelRole[] }[] = [
  {
    name: 'audio',
    needs: { hasAudio: true, hasPhotos: false, hasVideos: false, mode: 'default' },
    roles: ['perch', 'perch_labels'],
  },
  {
    name: 'photos and audio',
    needs: { hasAudio: true, hasPhotos: true, hasVideos: false, mode: 'default' },
    roles: [
      'detector',
      'classifier',
      'classifier_labels',
      'taxonomy',
      'geofence',
      'perch',
      'perch_labels',
    ],
  },
  {
    name: 'reference videos and audio',
    needs: { hasAudio: true, hasPhotos: false, hasVideos: true, mode: 'reference' },
    roles: [
      'detector_reference',
      'classifier',
      'classifier_labels',
      'taxonomy',
      'geofence',
      'perch',
      'perch_labels',
    ],
  },
];

export function defineModelCacheTests(test: typeof base) {
  for (const { name, needs, roles } of scenarios) {
    test(`${name}: a second load after navigation makes no model requests`, async ({
      page,
      context,
      baseURL,
    }) => {
      // Ephemeral WebKit contexts lose Cache Storage on reload: https://github.com/microsoft/playwright/issues/41618
      test.fail(test.info().project.name === 'webkit', 'Playwright WebKit cache reload issue');
      const moduleCode = await browserModule('src/app/models.ts');
      const moduleURL = new URL('models-test-module.js', baseURL).href;
      // Same-origin requests reach the service worker, whose fetches Playwright routes only in
      // Chromium; the stubbed model host is therefore one the policy allows and the module is
      // placed in the shell cache the worker serves from.
      const modelBaseURL = 'https://huggingface.co/deerdiary-models-test/';
      const manifest = syntheticModelManifest(modelBaseURL);
      const expectedFiles = manifest.filter((file) => roles.includes(file.role));
      const expectedModels = syntheticModels.filter((file) => roles.includes(file.role));
      const requests: string[] = [];
      for (const { role, body } of syntheticModels) {
        await context.route(new URL(role, modelBaseURL).href, (route) => {
          requests.push(route.request().url());
          return route.fulfill({
            contentType: 'application/octet-stream',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body,
          });
        });
      }
      const load = () =>
        page.evaluate(
          async ({ moduleURL, manifest, needs }) => {
            const module: { loadModels: typeof loadModels } = await import(moduleURL);
            const result = await module.loadModels(
              manifest,
              needs,
              undefined,
              {
                fetch: globalThis.fetch.bind(globalThis),
                caches: globalThis.caches,
                subtle: crypto.subtle,
                // Permission prompts and browser quota policy are outside this cache test.
                storage: {
                  persist: async () => false,
                  estimate: async () => ({
                    quota: manifest.reduce((total, file) => total + file.bytes, 0),
                    usage: 0,
                  }),
                },
              },
              manifest.find((file) => file.role === 'detector'),
            );
            return Array.from(result.models, ([role, buffer]) => [
              role,
              Array.from(new Uint8Array(buffer)),
            ]);
          },
          { moduleURL, manifest, needs },
        );
      const cachedURLs = () =>
        page.evaluate(async (moduleURL) => {
          const { MODEL_CACHE_NAME }: typeof import('../../src/app/models') = await import(
            moduleURL
          );
          const cache = await caches.open(MODEL_CACHE_NAME);
          return (await cache.keys()).map((request) => request.url).sort();
        }, moduleURL);
      await openApp(page);
      await page.evaluate(
        async ({ moduleURL, moduleCode }) => {
          const cache = await caches.open('deerdiary-shell-v1');
          await cache.put(
            moduleURL,
            new Response(moduleCode, { headers: { 'Content-Type': 'text/javascript' } }),
          );
        },
        { moduleURL, moduleCode },
      );
      const first = await test.step('download and verify the synthetic manifest', load);
      expect(first).toEqual(
        expectedModels.map(({ role, body }) => [role, Array.from(new TextEncoder().encode(body))]),
      );
      expect(requests).toEqual(expectedFiles.map((file) => file.url));
      const expectedURLs = expectedFiles.map((file) => file.url).sort();
      expect(
        await test.step('cache contains every selected URL before navigation', cachedURLs),
      ).toEqual(expectedURLs);
      requests.length = 0;
      await page.reload();
      expect(
        await test.step('cache retains every selected URL after navigation', cachedURLs),
      ).toEqual(expectedURLs);
      expect(await test.step('reuse verified cache bytes after navigation', load)).toEqual(first);
      expect(requests).toEqual([]);
    });
  }
}
