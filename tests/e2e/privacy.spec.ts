import { expect, type Page, type Worker } from '@playwright/test';
import { COEP, COOP, CSP } from '../../bin/headers.mjs';
import type * as models from '../../src/app/models';
import type * as network from '../../src/app/networkMeter';
import { browserModule } from '../fixtures/browser-module';
import { syntheticModelManifest, syntheticModels } from '../fixtures/models';
import { test } from '../fixtures/storage';

declare global {
  interface Window {
    privacyWorker: globalThis.Worker;
    privacy: {
      models: typeof models;
      meter: network.NetworkMeter;
    };
  }
}

async function openControlledApp(page: Page): Promise<Worker> {
  await page.addInitScript(() => {
    window.Worker = class extends Worker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        window.privacyWorker = this;
      }
    };
  });
  // The photo worker starts only in the controlled document, after the first-visit reload.
  const started = page.waitForEvent('worker', (worker) =>
    /\/assets\/photo\.worker-/.test(worker.url()),
  );
  await page.goto('./');
  const worker = await started;
  // A worker event precedes module loading; wait before fetching its script a second time.
  await worker.evaluate(() => crossOriginIsolated);
  return worker;
}

async function prepareMeter(page: Page, baseURL: string, modelURLs: string[]) {
  const sources = await Promise.all(
    ['models', 'networkMeter'].map(async (name) => ({
      url: new URL(`privacy-test/${name}.js`, baseURL).href,
      code: await browserModule(`src/app/${name}.ts`),
    })),
  );
  await page.evaluate(
    async ({ sources, modelURLs }) => {
      const cache = await caches.open('deerdiary-shell-v1');
      for (const { url, code } of sources) {
        await cache.put(
          url,
          new Response(code, { headers: { 'Content-Type': 'text/javascript' } }),
        );
      }
      const modelURL = sources.find(({ url }) => url.endsWith('/models.js'))?.url;
      const meterURL = sources.find(({ url }) => url.endsWith('/networkMeter.js'))?.url;
      if (!modelURL || !meterURL) throw new Error('Missing privacy test modules.');
      const modelModule: typeof models = await import(modelURL);
      const networkModule: typeof network = await import(meterURL);
      const meter = networkModule.createNetworkMeter(modelURLs);
      window.privacyWorker.addEventListener('message', (event: MessageEvent<unknown>) => {
        if (networkModule.isResourceMessage(event.data)) meter.record(event.data.resources);
      });
      networkModule.observeResources((resources) => meter.record(resources));
      window.privacy = { models: modelModule, meter };
    },
    { sources, modelURLs },
  );
}

test('controlled documents and photo scripts carry the shared policy and isolation headers', async ({
  page,
  context,
  baseURL,
  browserName,
}, testInfo) => {
  if (!baseURL) throw new Error('Privacy tests require baseURL.');
  // Emulate a static host's first document, before service worker headers exist.
  await context.route(
    baseURL,
    async (route) => {
      const response = await route.fetch();
      const headers = response.headers();
      delete headers['cross-origin-opener-policy'];
      delete headers['cross-origin-embedder-policy'];
      delete headers['content-security-policy'];
      await route.fulfill({ response, headers });
    },
    { times: 1 },
  );
  await page.addInitScript(() => {
    if (sessionStorage.getItem('privacy-first-isolation') === null) {
      sessionStorage.setItem('privacy-first-isolation', String(crossOriginIsolated));
    }
  });
  const worker = await openControlledApp(page);
  expect(await page.evaluate(() => sessionStorage.getItem('privacy-first-isolation'))).toBe(
    'false',
  );
  const headers = await page.evaluate(async (workerURL) => {
    const responses = await Promise.all([fetch(location.href), fetch(workerURL)]);
    return responses.map((response) => Object.fromEntries(response.headers));
  }, worker.url());
  for (const header of headers) {
    expect(header['content-security-policy']).toBe(CSP);
    expect(header['cross-origin-opener-policy']).toBe(COOP);
    expect(header['cross-origin-embedder-policy']).toBe(COEP);
  }
  const isolation = {
    page: await page.evaluate(() => crossOriginIsolated),
    worker: await worker.evaluate(() => crossOriginIsolated),
  };
  await testInfo.attach('cross-origin-isolation', {
    body: JSON.stringify(isolation),
    contentType: 'application/json',
  });
  if (browserName !== 'webkit') expect(isolation).toEqual({ page: true, worker: true });
});

test('the photo worker rejects a disallowed fetch and reports a CSP violation', async ({
  page,
}) => {
  const worker = await openControlledApp(page);
  const result = await worker.evaluate(async () => {
    const violation = new Promise<{ directive: string; blockedURI: string }>((resolve) => {
      self.addEventListener(
        'securitypolicyviolation',
        (event) => {
          resolve({ directive: event.effectiveDirective, blockedURI: event.blockedURI });
        },
        { once: true },
      );
    });
    const rejected = await fetch('https://example.com/').then(
      () => false,
      () => true,
    );
    return { rejected, violation: await violation };
  });
  expect(result.rejected).toBe(true);
  expect(result.violation.directive).toBe('connect-src');
  expect(new URL(result.violation.blockedURI).origin).toBe('https://example.com');
});

test('the meter includes page and photo-worker requests, including same-origin cache hits', async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error('Privacy tests require baseURL.');
  const worker = await openControlledApp(page);
  await prepareMeter(page, baseURL, []);
  const url = new URL('privacy-test/resource', baseURL).href;
  await page.evaluate(async (url) => {
    const cache = await caches.open('deerdiary-shell-v1');
    await cache.put(url, new Response('local resource'));
    window.privacy.meter.start();
    await fetch(url);
  }, url);
  await worker.evaluate(async (url) => {
    await fetch(url);
  }, url);
  await expect
    .poll(() => page.evaluate(() => window.privacy.meter.snapshot()))
    .toEqual({
      modelRequests: 0,
      modelBytes: 0,
      unknownModelSizes: 0,
      otherRequests: 2,
      hosts: { [new URL(baseURL).host]: 2 },
    });
});

test('synthetic photo-role models and the app shell survive offline reload with a zero meter', async ({
  page,
  context,
  baseURL,
}) => {
  // Playwright cannot route page requests in WebKit once a service worker controls
  // the page (https://playwright.dev/docs/service-workers), so the stubbed model
  // host is unreachable there.
  test.fail(
    test.info().project.name === 'webkit',
    'Playwright WebKit cannot route requests from service-worker-controlled pages',
  );
  if (!baseURL) throw new Error('Privacy tests require baseURL.');
  await openControlledApp(page);
  const manifest = syntheticModelManifest('https://huggingface.co/deerdiary-privacy-test/');
  for (const file of syntheticModels) {
    await context.route(`https://huggingface.co/deerdiary-privacy-test/${file.role}`, (route) =>
      route.fulfill({
        body: file.body,
        contentType: 'application/octet-stream',
        headers: { 'Access-Control-Allow-Origin': '*' },
      }),
    );
  }
  await prepareMeter(
    page,
    baseURL,
    manifest.map((file) => file.url),
  );
  const requests: { url: string; method: string; body: string | null }[] = [];
  context.on('request', (request) =>
    requests.push({
      url: request.url(),
      method: request.method(),
      body: request.postData(),
    }),
  );
  const load = () =>
    page.evaluate(async (manifest) => {
      window.privacy.meter.start();
      const result = await window.privacy.models.loadModels(
        manifest,
        {
          hasPhotos: true,
          hasVideos: false,
          hasAudio: false,
          mode: 'default',
        },
        undefined,
        {
          fetch: globalThis.fetch.bind(globalThis),
          caches,
          subtle: crypto.subtle,
          storage: {
            persist: async () => false,
            estimate: async () => ({ quota: 1_000_000, usage: 0 }),
          },
        },
        manifest.find((file) => file.role === 'detector'),
      );
      return Array.from(result.models, ([role, bytes]) => [
        role,
        Array.from(new Uint8Array(bytes)),
      ]);
    }, manifest);
  const online = await load();
  expect(online).toHaveLength(5);
  await expect
    .poll(() => page.evaluate(() => window.privacy.meter.snapshot().modelRequests))
    .toBe(5);
  for (const request of requests) {
    const url = new URL(request.url);
    expect(
      url.origin === new URL(baseURL).origin ||
        url.hostname === 'huggingface.co' ||
        url.hostname.endsWith('.hf.co'),
    ).toBe(true);
    expect(request.method).toBe('GET');
    expect(request.body).toBeNull();
  }
  expect(requests.filter(({ url }) => url.startsWith('https://huggingface.co/'))).toHaveLength(5);
  const listed: unknown = await page.evaluate(() =>
    fetch(new URL('precache.json', document.baseURI)).then((response) => response.json()),
  );
  const lazyChunks =
    Array.isArray(listed) && listed.every((path): path is string => typeof path === 'string')
      ? listed
      : [];
  if (lazyChunks.length === 0) throw new Error('The build lists no on-demand chunks to precache.');
  await context.unrouteAll();
  await context.setOffline(true);
  const response = await page.reload();
  expect(response?.fromServiceWorker()).toBe(true);
  await page.waitForFunction(() => window.privacyWorker);
  await prepareMeter(
    page,
    baseURL,
    manifest.map((file) => file.url),
  );
  expect(await load()).toEqual(online);
  // A task boundary lets resource observers report requests before the zero assertion.
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  expect(await page.evaluate(() => window.privacy.meter.snapshot())).toEqual({
    modelRequests: 0,
    modelBytes: 0,
    unknownModelSizes: 0,
    otherRequests: 0,
    hosts: {},
  });
  // The reel's MP4 writer is imported only on export, so this first visit never loaded it.
  const exports = await page.evaluate(async (paths) => {
    const names: string[] = [];
    for (const path of paths) {
      names.push(...Object.keys(await import(new URL(path, document.baseURI).href)));
    }
    return names;
  }, lazyChunks);
  expect(exports).toContain('Mp4OutputFormat');
});
