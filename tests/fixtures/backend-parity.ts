import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import manifest from '../../models/manifest.json' with { type: 'json' };
import type { SpeciesNetImage } from '../../src/core/speciesnetJson';
import type { HarnessConfig } from './photo-harness';
import { startPhotoHarness } from './photo-server';

// Run against the committed WASM sample, never the 2,000-image evaluation.
const modelRoot = process.argv[2];
if (!modelRoot)
  throw new Error('Usage: tsx tests/fixtures/backend-parity.ts <model-root> <report.json>');
const sample: { predictions: SpeciesNetImage[] } = JSON.parse(
  await readFile('public/sample/predictions.json', 'utf8'),
);
const harness = await startPhotoHarness({
  modelRoot,
  photos: sample.predictions.map(({ filepath }) => ({ filepath: resolve('public', filepath) })),
});
const browser = await chromium.launch({
  executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  headless: false,
});
const differences: { path: string; detail: string }[] = [];
let actualBackend: string | undefined;
try {
  const page = await browser.newPage();
  await page.goto(harness.url);
  const asset = (role: string) => {
    const file = manifest.local_exports.files.find(
      (file) =>
        file.role === role &&
        (role !== 'classifier' || ('precision' in file && file.precision === 'fp16')),
    );
    if (!file) throw new Error(`Missing ${role} in manifest`);
    return file.id;
  };
  const config: HarnessConfig = {
    backend: 'webgpu',
    modelBaseUrl: harness.modelBaseUrl,
    detector: manifest.default_detector,
    classifier: asset('classifier'),
    classifier_labels: asset('classifier_labels'),
    taxonomy: asset('taxonomy'),
    geofence: asset('geofence'),
  };
  actualBackend = (await page.evaluate((config) => window.photoHarness.initialize(config), config))
    .backend;
  for (const prediction of sample.predictions) {
    const filename = prediction.filepath.split('/').pop();
    const result = await page.evaluate(
      (url) => window.photoHarness.process(url, undefined, { country: 'USA' }),
      new URL(`photos/${filename}`, harness.modelBaseUrl).href,
    );
    if (result.status !== 'ok') {
      differences.push({ path: prediction.filepath, detail: result.status });
      continue;
    }
    const detections = result.detections.filter(
      (detection) => detection.raw_classifications !== undefined,
    );
    if (detections.length !== prediction.detections.length)
      differences.push({ path: prediction.filepath, detail: 'detection count' });
    for (const [index, expected] of prediction.detections.entries()) {
      const actual = detections[index];
      if (actual?.processed_classification?.source !== expected.processed_classification?.source)
        differences.push({ path: prediction.filepath, detail: `source ${index}` });
      if (
        actual?.processed_classification &&
        expected.processed_classification &&
        Math.abs(actual.processed_classification.score - expected.processed_classification.score) >
          0.005
      )
        differences.push({ path: prediction.filepath, detail: `classifier score ${index}` });
      if (actual?.processed_classification?.class !== expected.processed_classification?.class)
        differences.push({ path: prediction.filepath, detail: `label ${index}` });
      if (
        actual?.bbox.some(
          (coordinate, axis) => Math.abs(coordinate - (expected.bbox[axis] ?? 0)) > 0.001,
        )
      )
        differences.push({ path: prediction.filepath, detail: `box ${index}` });
      if (actual && Math.abs(actual.conf - expected.conf) > 0.005)
        differences.push({ path: prediction.filepath, detail: `detector score ${index}` });
    }
  }
} catch (cause) {
  differences.push({
    path: 'initialization',
    detail: cause instanceof Error ? cause.message : String(cause),
  });
} finally {
  await browser.close();
  await harness.close();
}
const report = {
  comparison: 'Committed WASM sample from tools/sample/predict_sample.ts',
  detector: manifest.default_detector,
  classifier: 'speciesnet-v403a-fp16',
  country: 'USA',
  scoreTolerance: 0.005,
  boxTolerance: 0.001,
  requestedBackend: 'webgpu',
  actualBackend,
  samplePhotos: sample.predictions.length,
  matches: actualBackend === 'webgpu' && differences.length === 0,
  differences,
};
await writeFile(
  process.argv[3] ?? '/tmp/wild-backend-parity.json',
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report));
