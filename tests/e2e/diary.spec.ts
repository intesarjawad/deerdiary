import { expect } from '@playwright/test';
import { openApp } from '../fixtures/app';
import {
  dropCard,
  expectCards,
  importPredictions,
  importStatus,
  readPredictions,
} from '../fixtures/predictions';
import { test } from '../fixtures/storage';

const MODEL_HOST = /(^|\.)huggingface\.co$|\.hf\.co$/;

for (const fixture of ['predictions.speciesnet.json', 'predictions.md.json']) {
  test(`an imported ${fixture} becomes the diary once its card is dropped`, async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    await openApp(page);

    await importPredictions(page, fixture, await readPredictions(fixture));
    await expect(importStatus(page)).toHaveText(
      'Predictions for 6 photos read. Drop the folder they were made from to see the diary.',
    );
    requests.length = 0;
    await dropCard(page);

    await expect(importStatus(page)).toHaveText('Showing 6 photos from the predictions file.');
    await expectCards(page, ['white-tailed deer', 'american black bear']);
    const diary = page.getByRole('region', { name: 'Species diary' });
    const cards = diary.getByRole('article');
    await expect(cards.nth(0)).toContainText(
      '2 independent detections · 3 photos · up to 2 at once',
    );
    await expect(cards.nth(1)).toContainText('1 independent detection · 1 photo · up to 1 at once');
    await expect(diary.locator('footer p').first()).toHaveText(
      '6 photos · 2 species · 1 blank photo · 1 person',
    );
    // The file carries the labels, so no model is fetched.
    expect(requests.filter((url) => MODEL_HOST.test(new URL(url).hostname))).toEqual([]);
  });
}

test('a malformed predictions file is rejected with the first bad field', async ({ page }) => {
  await openApp(page);
  const file = (await readPredictions('predictions.speciesnet.json')) as {
    predictions: { detections: { bbox: number[] }[] }[];
  };
  const [first] = file.predictions[0]?.detections ?? [];
  if (!first) throw new Error('The fixture has no detection to break.');
  first.bbox = [0.1, 0.2, 0.3];

  await importPredictions(page, 'broken.json', file);

  await expect(
    page.getByRole('region', { name: 'Import predictions' }).getByRole('alert'),
  ).toHaveText(
    'This file could not be imported: "predictions[0].detections[0].bbox" is missing or has the wrong type. What to do next',
  );
  await importPredictions(page, 'truncated.json', '{"predictions":');
  await expect(
    page.getByRole('region', { name: 'Import predictions' }).getByRole('alert'),
  ).toContainText('This file is not valid JSON.');
});

test('a correction immediately changes diary counts, clock and reel, and reset restores them', async ({
  page,
}) => {
  await openApp(page);
  await importPredictions(
    page,
    'predictions.speciesnet.json',
    await readPredictions('predictions.speciesnet.json'),
  );
  await dropCard(page);
  await expectCards(page, ['white-tailed deer', 'american black bear']);
  const clock = page.getByRole('region', { name: 'Detections by hour' });
  const before = await clock.textContent();
  const correction = page
    .getByRole('button', { name: 'Correct White-tailed deer', exact: true })
    .first();
  await correction.click();
  await page.getByRole('combobox', { name: 'Correct species' }).fill('human');
  await page.getByRole('option', { name: /Human/ }).first().click();
  await expect(
    page.getByRole('region', { name: 'Species diary' }).locator('footer p').first(),
  ).toContainText('3 people');
  await expect.poll(() => clock.textContent()).not.toBe(before);
  await page.getByRole('button', { name: 'Reset White-tailed deer', exact: true }).first().click();
  await expect.poll(() => clock.textContent()).toBe(before);
});
