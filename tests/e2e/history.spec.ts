import { readFile } from 'node:fs/promises';
import { expect, type Page } from '@playwright/test';
import { openApp } from '../fixtures/app';
import { test } from '../fixtures/storage';

const deer = 'deer-id;mammalia;artiodactyla;cervidae;odocoileus;virginianus;white-tailed deer';
const fox = 'fox-id;mammalia;carnivora;canidae;vulpes;vulpes;red fox';
const spring = Date.UTC(2026, 3, 1, 6);
const autumn = Date.UTC(2026, 9, 4, 6);
const autumnCorrection = `cam@${autumn}\u0000${fox}`;
const springCorrection = `cam@${spring}\u0000${deer}`;

type Seed = { id: string; createdAtMs: number; startMs: number; labels: string[] };

async function seed(page: Page, sessions: Seed[], corrections: Record<string, string>) {
  await page.evaluate(
    async ({ sessions, corrections }) => {
      const open = indexedDB.open('deerdiary');
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const names = ['results', 'corrections', 'sessions'];
      const tx = db.transaction(names, 'readwrite');
      const ms = {
        decode: 0,
        preprocess: 0,
        detect: 0,
        classify: 0,
        ensemble: 0,
        thumbnail: 0,
        total: 0,
      };
      for (const { id, createdAtMs, startMs, labels } of sessions) {
        const fileKeys: string[] = [];
        labels.forEach((label, index) => {
          const path = `cam/${id}-${index}.jpg`;
          const key = `${path}|1|2`;
          fileKeys.push(key);
          tx.objectStore('results').put({
            key,
            time: {
              wallClockMs: startMs + index * 10_000,
              wallClockHour: 6,
              timeSource: 'exif',
              offsetTimeOriginal: null,
              clockStatus: 'ok',
            },
            output: {
              path,
              backend: 'wasm',
              ms,
              status: 'ok',
              width: 160,
              height: 120,
              thumbnail: new Blob(['thumbnail']),
              detections: [
                {
                  category: '1',
                  label: 'animal',
                  conf: 0.9,
                  bbox: [0, 0, 0.5, 0.5],
                  processed_classification: { class: label, score: 0.9, source: 'classifier' },
                },
              ],
            },
          });
        });
        tx.objectStore('sessions').put({
          id,
          createdAtMs,
          fileKeys,
          dateRange: { first: startMs, last: startMs + (labels.length - 1) * 10_000 },
        });
      }
      for (const [key, value] of Object.entries(corrections)) {
        tx.objectStore('corrections').put(value, key);
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { sessions, corrections },
  );
}

async function counts(page: Page) {
  return page.evaluate(async () => {
    const open = indexedDB.open('deerdiary');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const count = (name: string) =>
      new Promise<number>((resolve, reject) => {
        const request = db.transaction(name).objectStore(name).count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const result = {
      results: await count('results'),
      sessions: await count('sessions'),
      corrections: await count('corrections'),
    };
    db.close();
    return result;
  });
}

async function openWithSessions(page: Page) {
  await openApp(page);
  // Seeding before the app creates its stores would leave it an empty database at the same version.
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await indexedDB.databases()).some(({ name }) => name === 'deerdiary'),
      ),
    )
    .toBe(true);
  await seed(
    page,
    [
      { id: 'spring', createdAtMs: 1_000, startMs: spring, labels: [deer, deer, fox] },
      { id: 'autumn', createdAtMs: 2_000, startMs: autumn, labels: [fox, fox] },
    ],
    { [springCorrection]: 'Elk', [autumnCorrection]: 'Dog' },
  );
  await page.reload();
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
}

test('lists the sessions newest first and says the export is the backup', async ({ page }) => {
  await openWithSessions(page);

  await expect(page.getByRole('region', { name: 'History' })).toContainText(
    "Clearing this site's data in the browser deletes your diaries; the export is the backup.",
  );
  await expect(page.getByRole('heading', { level: 3 })).toHaveText(['2026-10-04', '2026-04-01']);
  const newest = page.getByRole('article').first();
  await expect(newest).toContainText('2 photos');
  await expect(newest).toContainText('Dog: 1 independent detection');
});

test('keeps a session when the confirm dialog is dismissed', async ({ page }) => {
  await openWithSessions(page);
  page.once('dialog', (dialog) => void dialog.dismiss());

  await page.getByRole('button', { name: 'Delete this session' }).first().click();

  await expect(page.getByRole('article')).toHaveCount(2);
  expect(await counts(page)).toEqual({ results: 5, sessions: 2, corrections: 2 });
});

test('exports a session, deletes it, and imports it back with its corrections', async ({
  page,
}) => {
  await openWithSessions(page);
  expect(await counts(page)).toEqual({ results: 5, sessions: 2, corrections: 2 });

  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export this session' }).first().click();
  const download = await downloading;
  const path = await download.path();
  const text = await readFile(path, 'utf8');
  expect(JSON.parse(text).deerdiary.corrections).toEqual({ [autumnCorrection]: 'Dog' });

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Delete this session' }).first().click();

  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 3 })).toHaveText(['2026-04-01']);
  expect(await counts(page)).toEqual({ results: 3, sessions: 1, corrections: 1 });

  await page.getByLabel('Import a session file').setInputFiles({
    name: download.suggestedFilename(),
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  });

  await expect(page.getByRole('heading', { level: 3 })).toHaveText(['2026-10-04', '2026-04-01']);
  expect(await counts(page)).toEqual({ results: 5, sessions: 2, corrections: 2 });
  await page.reload();
  await expect(page.getByRole('article')).toHaveCount(2);
});

test('opens a saved diary with its corrections and no original files', async ({ page }) => {
  await openWithSessions(page);
  await page.getByRole('button', { name: 'Open this session' }).first().click();
  const diary = page.getByRole('region', { name: 'Species diary' });
  await expect(diary.getByRole('heading', { name: 'Dog', exact: true })).toBeVisible();
  await expect(diary.locator('footer p').first()).toContainText('2 photos');
  await expect(page.getByRole('slider', { name: 'Species reel' })).toHaveAttribute(
    'aria-valuetext',
    /Dog/,
  );
});

test('invalid dates already stored cannot break opening or deleting History', async ({ page }) => {
  await openWithSessions(page);
  await seed(page, [{ id: 'invalid', createdAtMs: 3000, startMs: 1e99, labels: [deer] }], {});
  await page.reload();
  const row = page.getByRole('region', { name: 'History' }).getByRole('article').first();
  await expect(row).toContainText('Invalid saved date');
  await row.getByRole('button', { name: 'Open this session' }).click();
  await expect(page.getByRole('alert')).toContainText('invalid camera times');
  page.once('dialog', (dialog) => void dialog.accept());
  await row.getByRole('button', { name: 'Delete this session' }).click();
  await expect(page.getByRole('region', { name: 'History' }).getByRole('article')).toHaveCount(2);
});
