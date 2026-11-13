import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import manifest from '../../models/manifest.json';
import { defaultPhotoModelFiles } from '../../src/app/models';
import {
  jpegPixelSize,
  medianMegapixels,
  parseBenchArgs,
  parseBenchmarkReport,
  photoModelIds,
  planPhotos,
  renderBenchmarkTable,
  updateResultsBlock,
} from '../../tools/bench/bench_photos';

const SOF0_4000X3000 = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x0b, 0xb8, 0x0f, 0xa0, 0x00, 0x00, 0x00, 0xff, 0xd9,
]);

test('cycles card photos and gives every fed copy its own path', () => {
  const photos = planPhotos(['a.jpg', 'nested/b.jpg'], 5, false);
  expect(photos.map((photo) => photo.benchPath)).toEqual([
    'bench/0/a.jpg',
    'bench/1/b.jpg',
    'bench/2/a.jpg',
    'bench/3/b.jpg',
    'bench/4/a.jpg',
  ]);
  expect(new Set(photos.map((photo) => photo.source)).size).toBe(2);
  expect(planPhotos(['a.jpg', 'b.jpg'], 5, true)).toEqual([
    { index: 0, source: 'a.jpg', benchPath: 'a.jpg' },
    { index: 1, source: 'b.jpg', benchPath: 'b.jpg' },
  ]);
  expect(() => planPhotos([], 1, false)).toThrow('No JPEG photos');
});

test('reads JPEG dimensions and gives the median megapixels', () => {
  expect(jpegPixelSize(SOF0_4000X3000)).toEqual({ width: 4000, height: 3000 });
  expect(jpegPixelSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
  expect(
    medianMegapixels([
      { width: 4000, height: 3000 },
      { width: 3000, height: 3000 },
      { width: 4000, height: 3000 },
    ]),
  ).toBe(12);
  expect(
    medianMegapixels([
      { width: 2000, height: 2000 },
      { width: 4000, height: 3000 },
    ]),
  ).toBe(8);
  expect(() => medianMegapixels([])).toThrow('No photo dimensions');
});

test('requires an ISO country code and a positive photo count', () => {
  expect(parseBenchArgs(['--count', '24', '--country', 'KEN', '--wasm'])).toMatchObject({
    count: 24,
    country: 'KEN',
    wasm: true,
    docs: false,
  });
  expect(parseBenchArgs(['docs', '--check'])).toMatchObject({ docs: true, check: true });
  expect(() => parseBenchArgs(['--count', '0'])).toThrow('positive integer');
  expect(() => parseBenchArgs(['--country', 'ke'])).toThrow('alpha-3');
  expect(() => parseBenchArgs(['--mode', 'fast'])).toThrow('default or reference');
});

test('reads a results report and renders the documentation table', async () => {
  const report = parseBenchmarkReport(
    JSON.parse(await readFile('tests/fixtures/bench-results.json', 'utf8')) as unknown,
  );
  expect(report.photos).toEqual({
    distinct: 42,
    fed: 10000,
    medianMegapixels: 12,
    upscaled: true,
  });
  expect(report.backends[0]?.stageMs.detect).toBe(12.7);
  expect(renderBenchmarkTable(report)).toBe(
    [
      '```text',
      '| Backend | Photos/s | First card (ms) | Decode (ms) | Detector (ms) | Classifier (ms) | Ensemble (ms) | Peak tree RSS (GB) | RSS after 2,000 (MB/photo) |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      '| webgpu | 18.42 | 2140.5 | 42.8 | 12.7 | 22.4 | 0.4 | 4.50 | 0.154 |',
      '| wasm | 3.61 | 5120.0 | 43.5 | 168.0 | 52.0 | 0.5 | 3.00 | 0.035 |',
      '```',
    ].join('\n'),
  );
  expect(() => parseBenchmarkReport({ ...report, backends: [] })).toThrow('nonempty array');
});

test('replaces only the marked results block', () => {
  const markdown =
    '# Benchmarks\n\nText.\n\n<!-- bench:results -->\nold\n<!-- /bench:results -->\n\nAfter.\n';
  expect(updateResultsBlock(markdown, 'new')).toBe(
    '# Benchmarks\n\nText.\n\n<!-- bench:results -->\nnew\n<!-- /bench:results -->\n\nAfter.\n',
  );
  expect(updateResultsBlock('# Benchmarks\n', 'new')).toBe(
    '# Benchmarks\n\n<!-- bench:results -->\nnew\n<!-- /bench:results -->\n',
  );
});

test('the benchmark selects the exact production photo model files', () => {
  const selected = photoModelIds('default');
  const exports = [...manifest.local_exports.files, ...manifest.local_detector_exports.files];
  for (const expected of defaultPhotoModelFiles(manifest, true)) {
    const file = exports.find((entry) => entry.id === selected.get(expected.role));
    expect(file?.sha256).toBe(expected.sha256);
  }
  expect(photoModelIds('reference').get('detector')).toBe('mdv5a');
});
