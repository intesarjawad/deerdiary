import { expect, test } from '@playwright/test';
import manifest from '../../models/manifest.json' with { type: 'json' };
import { intersectionOverUnion } from '../../src/core/nms';
import type { Detection } from '../../src/core/types';
import type { HarnessConfig } from '../fixtures/photo-harness';
import { photoFixtureSkipReason, startPhotoHarness } from '../fixtures/photo-server';
import none from '../golden/speciesnet_cli.none.json' with { type: 'json' };
import usa from '../golden/speciesnet_cli.usa.json' with { type: 'json' };

const MINIMUM_IOU = 0.99;
const goldens = [
  { name: 'none', country: undefined, predictions: none.predictions },
  { name: 'usa', country: 'USA', predictions: usa.predictions },
];

test('reference mode reproduces the official detections, classes and sources', async ({
  page,
}, testInfo) => {
  test.setTimeout(1_800_000);
  const detector = manifest.local_detector_exports.files.find(
    (model) => model.role === 'detector_reference',
  );
  test.skip(!detector, 'The fp16 reference detector export is not recorded in the manifest.');
  if (!detector) return;
  const backend = testInfo.project.name === 'chromium-headful' ? 'webgpu' : 'wasm';
  const precision = backend === 'webgpu' ? 'fp16' : 'fp32';
  const classifier = manifest.local_exports.files.find(
    (model) => model.role === 'classifier' && 'precision' in model && model.precision === precision,
  );
  const companion = (role: string) => {
    const asset = manifest.local_exports.files.find((model) => model.role === role);
    if (!asset) throw new Error(`Missing ${role} test asset`);
    return asset.id;
  };
  if (!classifier) throw new Error(`Missing ${precision} classifier`);
  const missing = photoFixtureSkipReason();
  test.skip(missing !== undefined, missing ?? '');
  const harness = await startPhotoHarness();
  try {
    await page.goto(harness.url);
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    const config: HarnessConfig = {
      backend,
      modelBaseUrl: harness.modelBaseUrl,
      detector: detector.id,
      detectorKind: 'reference',
      classifier: classifier.id,
      classifier_labels: companion('classifier_labels'),
      taxonomy: companion('taxonomy'),
      geofence: companion('geofence'),
    };
    await page.evaluate((config) => window.photoHarness.initialize(config), config);
    let compared = 0;
    for (const golden of goldens) {
      expect(golden.predictions).toHaveLength(16);
      for (const reference of golden.predictions) {
        const filename = reference.filepath.split('/').pop();
        const label = `${golden.name} ${filename}`;
        const result = await page.evaluate(
          ({ url, settings }) => window.photoHarness.process(url, undefined, settings),
          {
            url: new URL(`photos/${filename}`, harness.modelBaseUrl).href,
            settings: golden.country === undefined ? {} : { country: golden.country },
          },
        );
        expect(result.status, label).toBe('ok');
        if (result.status !== 'ok') throw new Error(`Could not decode ${filename}`);
        expect(result.detections, label).toHaveLength(reference.detections.length);
        const unmatched = [...result.detections];
        for (const expected of reference.detections) {
          const [x, y, width, height] = expected.bbox;
          if (x === undefined || y === undefined || width === undefined || height === undefined)
            throw new Error(`Invalid golden box: ${label}`);
          const box: Detection['bbox'] = [x, y, width, height];
          const candidates = unmatched.filter((value) => value.category === expected.category);
          const best = candidates.toSorted(
            (a, b) => intersectionOverUnion(b.bbox, box) - intersectionOverUnion(a.bbox, box),
          )[0];
          expect(best, `${label} has a class ${expected.category} detection`).toBeDefined();
          if (!best) continue;
          unmatched.splice(unmatched.indexOf(best), 1);
          expect(
            intersectionOverUnion(best.bbox, box),
            `${label} box ${expected.bbox.join(',')}`,
          ).toBeGreaterThanOrEqual(MINIMUM_IOU);
          expect(best.processed_classification?.class, `${label} class`).toBe(
            expected.processed_classification?.class,
          );
          expect(best.processed_classification?.source, `${label} source`).toBe(
            expected.processed_classification?.source,
          );
          compared++;
        }
      }
    }
    expect(compared).toBe(184);
  } finally {
    try {
      await page.evaluate(() => window.photoHarness?.close());
    } finally {
      await harness.close();
    }
  }
});
