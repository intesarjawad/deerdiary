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

type Detection = { raw_classifications?: { classes: string[]; scores: number[] } };
type SpeciesNetFile = { predictions: { detections: Detection[] }[] };

const RAW_CLASSES_KEPT = 2;

/** What `run_model` writes without `--max_classifications_per_detection 5`. */
async function twoClassPredictions(): Promise<SpeciesNetFile> {
  const file = (await readPredictions('predictions.speciesnet.json')) as SpeciesNetFile;
  for (const photo of file.predictions) {
    for (const detection of photo.detections) {
      const raw = detection.raw_classifications;
      if (raw === undefined) continue;
      raw.classes = raw.classes.slice(0, RAW_CLASSES_KEPT);
      raw.scores = raw.scores.slice(0, RAW_CLASSES_KEPT);
    }
  }
  return file;
}

test('a file with two raw classes keeps its labels on a country change and says so', async ({
  page,
}) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await openApp(page);
  await importPredictions(page, 'out.json', await twoClassPredictions());
  await dropCard(page);
  await expect(importStatus(page)).toHaveText('Showing 6 photos from the predictions file.');
  await expectCards(page, ['white-tailed deer', 'american black bear']);
  const country = page.getByRole('combobox', { name: 'Country' });
  await expect(country).toHaveAccessibleDescription(/Country fixed by the imported file/);
  requests.length = 0;

  await country.selectOption('GBR');

  await expect(country).toHaveValue('GBR');
  await expect(page.getByText('Country fixed by the imported file')).toBeVisible();
  await expectCards(page, ['white-tailed deer', 'american black bear']);
  // Nothing can be relabelled, so the change loads no model.
  expect(requests.filter((url) => MODEL_HOST.test(new URL(url).hostname))).toEqual([]);
});
