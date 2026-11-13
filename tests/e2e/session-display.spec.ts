import { expect } from '@playwright/test';
import { dropCard } from '../fixtures/predictions';
import { sessionShell } from '../fixtures/session-shell';
import { test } from '../fixtures/storage';

let shell: Awaited<ReturnType<typeof sessionShell>>;
test.beforeAll(async () => {
  shell = await sessionShell();
});
test.beforeEach(async ({ page }) => {
  await page.route('**/session-shell.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: shell.script }),
  );
  await page.route('**/session-shell.css', (route) =>
    route.fulfill({ contentType: 'text/css', body: shell.css }),
  );
  await page.route('**/session-shell.html', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><link rel="stylesheet" href="./session-shell.css"></head><body><div id="app"></div><script type="module" src="./session-shell.js"></script></body></html>',
    }),
  );
  await page.addInitScript(() => {
    class PhotoWorker extends EventTarget {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror = null;
      postMessage(message: { kind?: string; file?: File; settings?: { path?: string } }) {
        if (message.kind === 'init') {
          queueMicrotask(() =>
            this.onmessage?.(
              new MessageEvent('message', { data: { kind: 'initialized', backend: 'wasm' } }),
            ),
          );
          return;
        }
        if (message.file) {
          const file = message.file;
          document.documentElement.dataset.photoPending = 'true';
          addEventListener(
            'photos-ready',
            () =>
              this.onmessage?.(
                new MessageEvent('message', {
                  data: {
                    status: 'ok',
                    path: message.settings?.path,
                    backend: 'wasm',
                    width: 10,
                    height: 10,
                    thumbnail: file,
                    detections: [],
                    ms: {
                      decode: 0,
                      preprocess: 0,
                      detect: 0,
                      classify: 0,
                      ensemble: 0,
                      thumbnail: 0,
                      total: 0,
                    },
                  },
                }),
              ),
            { once: true },
          );
        }
      }
      terminate() {}
    }
    Object.defineProperty(window, 'Worker', { value: PhotoWorker });
  });
  await page.goto('session-shell.html');
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await indexedDB.databases()).some(({ name }) => name === 'deerdiary'),
      ),
    )
    .toBe(true);
  // The database is listed as soon as it is requested; opening it waits for the upgrade, after
  // which the app assigns its storage. A drop before that is refused with a "still starting" alert.
  await page.evaluate(
    () =>
      new Promise<void>((accept, reject) => {
        const request = indexedDB.open('deerdiary');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          request.result.close();
          accept();
        };
      }),
  );
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`model progress stays inside intake at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await dropCard(page);
    const loading = page.getByText('Loading the photo models.', { exact: true });
    await expect(loading).toBeVisible();
    await expect(page.locator('.intake .model-load progress')).toHaveCount(1);
    await expect
      .poll(async () => {
        const box = await loading.boundingBox();
        return !!box && box.y >= 0 && box.y + box.height <= viewport.height;
      })
      .toBe(true);
  });
}

test('a running folder keeps its intake, originals and session when another drop arrives', async ({
  page,
}) => {
  await dropCard(page);
  await expect(page.getByText('Loading the photo models.', { exact: true })).toBeVisible();
  await page.evaluate(() => dispatchEvent(new Event('models-ready')));
  await expect(page.getByText('0 / 6 photos', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose a folder' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Try the sample' })).toBeDisabled();
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(['different'], 'second.jpg'));
    return data;
  });
  await page
    .getByRole('region', { name: 'Folder intake' })
    .dispatchEvent('drop', { dataTransfer: transfer });
  await transfer.dispose();
  await expect(page.getByRole('region', { name: 'Folder intake' })).toContainText('6 photos');
  await expect(page.getByRole('region', { name: 'Folder intake' })).not.toContainText('1 photo,');
  for (let index = 1; index <= 6; index++) {
    await expect(page.locator('html')).toHaveAttribute('data-photo-pending', 'true');
    await page.evaluate(() => {
      delete document.documentElement.dataset.photoPending;
      dispatchEvent(new Event('photos-ready'));
    });
    await expect(page.getByText(`${index} / 6 photos`, { exact: true })).toBeVisible();
  }
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Choose a folder' })).toBeEnabled();
  await expect(page.getByRole('region', { name: 'History' }).getByRole('article')).toHaveCount(1);
  await page.getByRole('button', { name: 'Try the sample' }).click();
  await expect(page.getByRole('region', { name: 'Species diary' })).toContainText('60 photos');
  await page.getByRole('combobox', { name: 'Country' }).selectOption('CAN');
  await expect(page.getByRole('region', { name: 'Species diary' })).toContainText('60 photos');
  await page.getByRole('button', { name: 'Open this session' }).click();
  await expect(page.getByText('6 / 6 photos', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Country' }).selectOption('GBR');
  await expect(page.getByText('6 / 6 photos', { exact: true })).toBeVisible();
});
