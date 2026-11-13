import { expect, test } from '@playwright/test';
import manifest from '../../models/manifest.json' with { type: 'json' };
import type { Detection } from '../../src/core/types';
import { CLASSIFICATION_THRESHOLD, MAX_CROPS_PER_IMAGE } from '../../src/workers/photo';
import type { HarnessConfig } from '../fixtures/photo-harness';
import { photoFixtureSkipReason, startPhotoHarness } from '../fixtures/photo-server';
import raw from '../golden/speciesnet_cli.raw.json' with { type: 'json' };

// CMYK retains the same gate until a measured conversion difference justifies a documented exception.
test('golden crop classifications and full photo inference', async ({
  page,
  browserName,
}, testInfo) => {
  test.setTimeout(900_000);
  const backend = testInfo.project.name === 'chromium-headful' ? 'webgpu' : 'wasm';
  // WebKit decodes the same JPEG to different pixel values than Chromium, Firefox and the
  // reference pipeline, which moves scores past the WASM tolerance and swaps near-tied classes,
  // so it is held to the top-one check the WebGPU path uses.
  const exactRanking = backend === 'wasm' && browserName !== 'webkit';
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
  expect(manifest.default_detector).toBe('mdv6-apa-rtdetr-c-fp32');
  expect(raw.predictions).toHaveLength(16);
  const missing = photoFixtureSkipReason();
  test.skip(missing !== undefined, missing ?? '');
  const harness = await startPhotoHarness();
  try {
    await page.goto(harness.url);
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    const config: HarnessConfig = {
      backend,
      modelBaseUrl: harness.modelBaseUrl,
      detector: manifest.default_detector,
      classifier: classifier.id,
      classifier_labels: companion('classifier_labels'),
      taxonomy: companion('taxonomy'),
      geofence: companion('geofence'),
    };
    expect(await page.evaluate((config) => window.photoHarness.initialize(config), config)).toEqual(
      { backend },
    );
    let maximumScoreDifference = 0;
    let classifiedCrops = 0;
    const perImage: { file: string; crops: number; maximumScoreDifference: number }[] = [];
    for (const reference of raw.predictions) {
      const filename = reference.filepath.split('/').pop();
      const detections: Detection[] = reference.detections.map((value) => {
        const [x, y, width, height] = value.bbox;
        if (
          (value.category !== '1' && value.category !== '2' && value.category !== '3') ||
          x === undefined ||
          y === undefined ||
          width === undefined ||
          height === undefined
        )
          throw new Error('Invalid golden detection');
        return { category: value.category, conf: value.conf, bbox: [x, y, width, height] };
      });
      const result = await page.evaluate(
        ({ url, detections }) => window.photoHarness.process(url, detections),
        { url: new URL(`photos/${filename}`, harness.modelBaseUrl).href, detections },
      );
      expect(result.status, filename).toBe('ok');
      if (result.status !== 'ok') throw new Error(`Could not decode ${filename}`);
      expect(result.backend).toBe(backend);
      expect(result.detections).toHaveLength(reference.detections.length);
      expect(result.ms.detect).toBe(0);
      const expected = reference.detections
        .toSorted((a, b) => b.conf - a.conf)
        .filter((detection) => detection.conf >= CLASSIFICATION_THRESHOLD)
        .slice(0, MAX_CROPS_PER_IMAGE);
      const actual = result.detections.filter((detection) => detection.raw_classifications);
      expect(actual, filename).toHaveLength(expected.length);
      let imageDifference = 0;
      for (const [index, detection] of actual.entries()) {
        const want = expected[index]?.raw_classifications;
        const got = detection.raw_classifications;
        if (!want || !got) throw new Error(`Missing crop reference: ${filename} ${index}`);
        expect(detection.processed_classification, `${filename} ${index} ensemble`).toBeDefined();
        if (exactRanking)
          expect(got.classes, `${filename} ${index} top five`).toEqual(want.classes);
        else expect(got.classes[0], `${filename} ${index} top one`).toBe(want.classes[0]);
        for (const [rank, label] of got.classes.entries()) {
          const expectedRank = want.classes.indexOf(label);
          const expectedScore = expectedRank < 0 ? 0 : (want.scores[expectedRank] ?? 0);
          const difference = Math.abs((got.scores[rank] ?? 0) - expectedScore);
          imageDifference = Math.max(imageDifference, difference);
          if (exactRanking)
            expect(difference, `${filename} ${index} score ${rank}`).toBeLessThanOrEqual(0.005);
        }
        classifiedCrops++;
      }
      maximumScoreDifference = Math.max(maximumScoreDifference, imageDifference);
      perImage.push({
        file: filename ?? reference.filepath,
        crops: actual.length,
        maximumScoreDifference: imageDifference,
      });
    }
    expect(classifiedCrops).toBe(38);
    await testInfo.attach('classifier-score-differences', {
      body: JSON.stringify(
        { backend, precision, classifiedCrops, maximumScoreDifference, perImage },
        null,
        2,
      ),
      contentType: 'application/json',
    });
    const full = await page.evaluate(
      (url) => window.photoHarness.process(url),
      new URL('photos/american_black_bear.jpg', harness.modelBaseUrl).href,
    );
    expect(full.status).toBe('ok');
    if (full.status !== 'ok') throw new Error('Full photo inference failed');
    expect(full.ms.detect).toBeGreaterThan(0);
    expect(
      full.detections.some((value) => value.raw_classifications && value.processed_classification),
    ).toBe(true);
    const preview = await page.evaluate(
      (url) =>
        window.photoHarness.process(url).then(async (result) => {
          if (result.status !== 'ok') throw new Error('Thumbnail photo failed');
          const bitmap = await createImageBitmap(result.thumbnail);
          try {
            return { width: bitmap.width, height: bitmap.height, type: result.thumbnail.type };
          } finally {
            bitmap.close();
          }
        }),
      new URL('photos/american_black_bear.jpg', harness.modelBaseUrl).href,
    );
    expect(preview).toEqual({ width: 256, height: 192, type: 'image/jpeg' });
  } finally {
    try {
      await page.evaluate(() => window.photoHarness?.close());
    } finally {
      await harness.close();
    }
  }
});
