import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import manifest from '../../models/manifest.json' with { type: 'json' };
import { openApp } from '../fixtures/app';
import { test } from '../fixtures/storage';

const PREDICTIONS = 'public/sample/predictions.json';
// The finished sample diary appears within one second of the click.
const SAMPLE_BUDGET_MS = 1_000;
const MODEL_HOST = /(^|\.)huggingface\.co$|\.hf\.co$/;

type Prediction = {
  filepath: string;
  detections?: { processed_classification?: { class: string; source: string } }[];
};

test.skip(
  !existsSync(PREDICTIONS),
  'The sample is not committed: public/sample/ needs its photos, PROVENANCE.txt, predictions.json and thumbs/.',
);

function labelsByPhoto(text: string): Map<string, string[]> {
  const { predictions } = JSON.parse(text) as { predictions: Prediction[] };
  return new Map(
    predictions.map(({ filepath, detections = [] }) => [
      filepath,
      detections.map(
        ({ processed_classification: label }) => `${label?.class ?? ''} via ${label?.source ?? ''}`,
      ),
    ]),
  );
}

test('"Try the sample" shows the precomputed diary and fetches no model', async ({ page }) => {
  await openApp(page);
  const requests: URL[] = [];
  page.on('request', (request) => requests.push(new URL(request.url())));
  await page.getByRole('button', { name: 'Try the sample' }).click();
  await expect(page.getByRole('region', { name: 'Species diary' })).toBeVisible();
  await expect(page.getByText('Computed ahead of time by this app.')).toBeVisible();
  await expect(page.locator('.notice')).toContainText(
    'These model predictions include mistakes; review the photos.',
  );
  expect(requests.filter(({ hostname }) => MODEL_HOST.test(hostname))).toEqual([]);
});

test('isolated sample timing stays below one second', async ({ page }, testInfo) => {
  test.skip(
    process.env.WILD_TIMING_GATES !== '1',
    'The 1s budget is enforced alone in the sample-timing CI job. Set WILD_TIMING_GATES=1 on an isolated runner to measure it.',
  );
  await openApp(page);
  await expect(page.locator('.joiner-stage')).toHaveAttribute('data-gl', /^(on|off)$/);
  const elapsed = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const button = document.querySelector<HTMLButtonElement>('button.try-sample');
        if (!button) {
          reject(new Error('The sample button is missing.'));
          return;
        }
        const clicked = performance.now();
        const observer = new MutationObserver(() => {
          if (!document.querySelector('section[aria-label="Species diary"]')) return;
          observer.disconnect();
          resolve(performance.now() - clicked);
        });
        observer.observe(document.body, { childList: true, subtree: true });
        button.click();
      }),
  );
  await testInfo.attach('sample-timing', {
    body: JSON.stringify({ elapsedMs: elapsed }),
    contentType: 'application/json',
  });
  expect(elapsed).toBeLessThan(SAMPLE_BUDGET_MS);
});

test('the sample sheet discloses model mistakes and preserves its measured tallies', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openApp(page);
  await expect(page.locator('figcaption')).toContainText(
    'These model predictions include mistaken labels and detections in empty frames.',
  );
  await expect(page.locator('.sheet .tallies dd')).toHaveText(['8', '5', '3']);
});

test('"Run it in this tab" labels every sample photo as the precomputed file does', async ({
  page,
}) => {
  const published = new Set(manifest.files.map(({ id }) => id));
  const needed = [
    manifest.default_detector,
    ...manifest.local_exports.files
      .filter(
        (file) => file.role !== 'classifier' || ('precision' in file && file.precision === 'fp16'),
      )
      .map(({ id }) => id),
  ];
  test.skip(
    needed.some((id) => !published.has(id)),
    'The default photo models are not published, so the app cannot run them.',
  );
  // Sixty photos on one WASM thread pool take minutes on a CI runner.
  test.setTimeout(600_000);
  const expected = labelsByPhoto(await readFile(PREDICTIONS, 'utf8'));
  await openApp(page);

  await page.getByRole('button', { name: 'Try the sample' }).click();
  await page.getByRole('button', { name: 'Run it in this tab' }).click();
  const history = page.getByRole('region', { name: 'History' });
  await expect(history.getByRole('article')).toHaveCount(1, { timeout: 540_000 });
  await expect(history.getByRole('article')).toContainText(`${expected.size} photos`);
  const downloading = page.waitForEvent('download');
  await history.getByRole('button', { name: 'Export this session' }).click();
  const download = await downloading;
  const path = await download.path();

  expect(labelsByPhoto(await readFile(path, 'utf8'))).toEqual(expected);
});

test('a press before the first visit reloads under the service worker still opens the sample', async ({
  page,
  context,
}) => {
  // Holding the worker script back keeps the first document up long enough to be pressed.
  await context.route('**/sw.js', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue();
  });
  await page.goto('./');
  // A locator click would wait out the reload; this press has to land on the first document.
  const pressedOn = await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('button.try-sample')?.click();
    return (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).type;
  });
  expect(pressedOn).toBe('navigate');
  await page.waitForFunction(
    () =>
      (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).type ===
      'reload',
  );
  await expect(page.getByRole('region', { name: 'Species diary' })).toBeVisible();
  await expect(page.getByText('Computed ahead of time by this app.')).toBeVisible();
});
