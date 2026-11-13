import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import preact from '@preact/preset-vite';
import { build } from 'vite';

let bundle = '';
let fixtureRoot = '';
const expectedSummary = '12 photos, 2 videos, 1 audio file, 1 unsupported (.heic)';

test.beforeAll(async () => {
  // Exercise intake independently until the app shell connects the drop flow.
  const componentPath = fileURLToPath(new URL('../../src/ui/DropZone.tsx', import.meta.url));
  const harnessEntry = fileURLToPath(new URL('../../scan-harness.js', import.meta.url));
  const result = await build({
    configFile: false,
    plugins: [
      preact(),
      {
        name: 'scan-component-harness',
        resolveId(id) {
          if (id === harnessEntry) return '\0scan-harness';
        },
        load(id) {
          if (id === '\0scan-harness')
            return `
          import { h, render } from 'preact';
          import { DropZone } from ${JSON.stringify(componentPath)};
          render(h(DropZone, {}), document.getElementById('app'));
        `;
        },
      },
    ],
    build: { write: false, lib: { entry: harnessEntry, formats: ['es'] } },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const chunk = outputs
    .flatMap((output) => ('output' in output ? output.output : []))
    .find((item) => item.type === 'chunk');
  if (!chunk) throw new Error('The intake harness bundle is missing.');
  bundle = chunk.code;
  fixtureRoot = await mkdtemp(join(tmpdir(), 'deerdiary-scan-'));
  const directory = join(fixtureRoot, 'card', 'DCIM', '100MEDIA');
  await mkdir(directory, { recursive: true });
  // Scanning only reads file metadata; image decoding is a separate processing step.
  await Promise.all(
    [
      ...Array.from({ length: 12 }, (_, index) => `${index}.JPG`),
      'clip.mp4',
      'clip.avi',
      'sound.wav',
      'image.heic',
      '.hidden.jpg',
      'THUMB001.JPG',
    ].map((name) => writeFile(join(directory, name), 'scan fixture')),
  );
  for (const name of ['.thumbnails', 'System Volume Information']) {
    const hidden = join(fixtureRoot, 'card', name);
    await mkdir(hidden);
    await writeFile(join(hidden, 'ignored.jpg'), 'ignored');
  }
});

test.afterAll(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

test.beforeEach(async ({ page, baseURL }) => {
  if (!baseURL) throw new Error('The scan harness requires baseURL.');
  await page.route(new URL('scan-harness.js', baseURL).href, (route) =>
    route.fulfill({ contentType: 'text/javascript', body: bundle }),
  );
  await page.route(new URL('scan-harness.html', baseURL).href, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="en"><title>Folder intake test</title><div id="app"></div><script type="module" src="./scan-harness.js"></script></html>',
    }),
  );
  await page.goto('scan-harness.html');
});

test('directory input shows the fixture kind summary within one second', async ({ page }) => {
  await page.evaluate(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: undefined });
  });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose a folder' }).click();
  await (await chooser).setFiles(join(fixtureRoot, 'card'));
  await expect(page.getByRole('status')).toHaveText(expectedSummary, { timeout: 1000 });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('native file drops show the same summary on every engine', async ({ page }) => {
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    const names = [
      ...Array.from({ length: 12 }, (_, index) => `${index}.jpg`),
      'clip.mp4',
      'clip.avi',
      'sound.wav',
      'image.heic',
      '.hidden.jpg',
      'THUMB001.JPG',
    ];
    for (const name of names) data.items.add(new File(['fixture'], name));
    return data;
  });
  await page
    .getByRole('region', { name: 'Folder intake' })
    .dispatchEvent('drop', { dataTransfer: transfer });
  await expect(page.getByRole('status')).toHaveText(expectedSummary, { timeout: 1000 });
  await transfer.dispose();
});

test('picker scans a native directory handle when the API is available', async ({ page }) => {
  // Ephemeral WebKit contexts cannot open OPFS: https://github.com/microsoft/playwright/issues/18235
  test.fail(test.info().project.name === 'webkit', 'WebKit ephemeral context OPFS access issue');
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const card = await root.getDirectoryHandle('card', { create: true });
    const directory = await card.getDirectoryHandle('DCIM', { create: true });
    for (const name of [
      ...Array.from({ length: 12 }, (_, index) => `${index}.jpg`),
      'clip.mp4',
      'clip.avi',
      'sound.wav',
      'image.heic',
      '.hidden.jpg',
    ])
      await directory.getFileHandle(name, { create: true });
    // Keep native handles while replacing only the interactive permission prompt.
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: async () => card,
    });
  });
  await page.getByRole('button', { name: 'Choose a folder' }).click();
  await expect(page.getByRole('status')).toHaveText(expectedSummary, { timeout: 1000 });
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('card', { recursive: true });
  });
});

test('picker errors are actionable and cancellation allows another selection', async ({ page }) => {
  await page.evaluate(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: () => Promise.reject(new DOMException('Access denied', 'NotAllowedError')),
    });
  });
  await page.getByRole('button', { name: 'Choose a folder' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Choose it again and allow access. Access denied',
  );
  await page.evaluate(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: () => Promise.reject(new DOMException('Cancelled', 'AbortError')),
    });
  });
  await page.getByRole('button', { name: 'Choose a folder' }).click();
  await expect(page.getByRole('status')).toHaveText('No folder selected.');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Choose a folder' })).toBeEnabled();
});
