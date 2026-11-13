import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import manifest from '../../models/manifest.json' with { type: 'json' };
import { openApp } from '../fixtures/app';
import { photoFixtureSkipReason } from '../fixtures/photo-server';
import { test } from '../fixtures/storage';
import raw from '../golden/speciesnet_cli.raw.json' with { type: 'json' };

const PHOTO_COUNT = 12;
const PROCESSING_TIMEOUT_MS = 600_000;

declare global {
  interface Window {
    photoRequestCount: number;
  }
}

let card = '';

test.beforeAll(async () => {
  const missing = photoFixtureSkipReason();
  test.skip(missing !== undefined, missing ?? '');
  const root = await mkdtemp(join(tmpdir(), 'deerdiary-resume-'));
  card = join(root, 'card');
  await mkdir(card);
  await Promise.all(
    raw.predictions
      .slice(0, PHOTO_COUNT)
      .map(({ filepath }) => copyFile(filepath, join(card, basename(filepath)))),
  );
});

test.afterAll(async () => {
  if (card) await rm(join(card, '..'), { recursive: true, force: true });
});

async function chooseCard(page: Page) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose a folder' }).click();
  await (await chooser).setFiles(card);
}

test('a card dropped again after a reload is restored without inference', async ({
  page,
  context,
}) => {
  test.setTimeout(900_000);
  const exported = [...manifest.local_exports.files, ...manifest.local_detector_exports.files];
  const published = manifest.files.flatMap(({ id, url }) => {
    const local = exported.find((file) => file.id === id);
    return local ? [{ url, path: local.local_path }] : [];
  });
  test.skip(
    published.length === 0,
    'The manifest has no published addresses for the default photo models; resume-through-inference requires those integrity-pinned exports.',
  );
  const modelRequests: string[] = [];
  for (const { url, path } of published) {
    await context.route(url, (route) => {
      modelRequests.push(url);
      return route.fulfill({
        path,
        contentType: 'application/octet-stream',
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    });
  }
  await page.addInitScript(() => {
    window.photoRequestCount = 0;
    Worker.prototype.postMessage = new Proxy(Worker.prototype.postMessage, {
      apply(post, worker, args: unknown[]) {
        const [message] = args;
        if (typeof message === 'object' && message !== null && 'file' in message) {
          window.photoRequestCount += 1;
        }
        return Reflect.apply(post, worker, args);
      },
    });
    // The directory input is the intake every engine can be driven through.
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: undefined });
  });
  const finished = page.getByText(`${PHOTO_COUNT} / ${PHOTO_COUNT} photos`);

  await openApp(page);
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await indexedDB.databases()).some(({ name }) => name === 'deerdiary'),
      ),
    )
    .toBe(true);
  await chooseCard(page);
  await expect(finished).toBeVisible({ timeout: PROCESSING_TIMEOUT_MS });
  expect(await page.evaluate(() => window.photoRequestCount)).toBe(PHOTO_COUNT);
  expect(modelRequests).not.toHaveLength(0);

  modelRequests.length = 0;
  await page.reload();
  await expect(page.getByRole('article')).toHaveCount(1);
  await chooseCard(page);
  await expect(finished).toBeVisible({ timeout: PROCESSING_TIMEOUT_MS });

  expect(await page.evaluate(() => window.photoRequestCount)).toBe(0);
  expect(modelRequests).toEqual([]);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
