import { expect, test } from 'vitest';
import {
  budgetViolations,
  type ColdstartReport,
  isModelUrl,
  type ManifestLike,
  modelFilePath,
  parseColdstartArgs,
  parseColdstartReport,
  renderColdstartTable,
  runModelFiles,
  t3BudgetMs,
  t3SkipReason,
  transferMs,
  updateResultsBlock,
} from '../../tools/coldstart/coldstart';

const report: ColdstartReport = {
  generatedAt: '2026-11-06T18:00:00.000Z',
  machine: 'Test machine, arm64, 16 GB',
  userAgent: 'Test agent',
  engine: 'chromium',
  url: 'http://localhost:4173/',
  modelsSource: 'local',
  network: { downloadMbit: 50, uploadMbit: 10, latencyMs: 20 },
  t1Ms: 2_100,
  t2Ms: 640,
  t3Ms: 21_500,
  budgets: { t1Ms: 3_000, t2Ms: 1_000, t3Ms: 30_000 },
  crossOriginIsolated: true,
  singleThreadMessage: false,
  sensitiveElements: [],
};

const source: ManifestLike = {
  default_detector: 'det-fp32',
  local_exports: {
    files: [
      { id: 'cls-fp32', role: 'classifier', bytes: 40_000_000, precision: 'fp32' },
      { id: 'cls-fp16', role: 'classifier', bytes: 20_000_000, precision: 'fp16' },
      { id: 'labels', role: 'classifier_labels', bytes: 1_000_000 },
      { id: 'tax', role: 'taxonomy', bytes: 2_000_000 },
      { id: 'geo', role: 'geofence', bytes: 3_000_000 },
    ],
  },
  local_detector_exports: {
    files: [
      { id: 'det-fp16', role: 'detector', bytes: 5_000_000, precision: 'fp16' },
      { id: 'det-fp32', role: 'detector', bytes: 10_000_000, precision: 'fp32' },
    ],
  },
};

test('defaults to chromium and the package homepage, and validates options', () => {
  expect(parseColdstartArgs([], 'https://example.test/app/')).toEqual({
    docs: false,
    check: false,
    engine: 'chromium',
    url: 'https://example.test/app/',
  });
  expect(
    parseColdstartArgs(
      ['--url', 'http://localhost:4173', '--models-from', '.cache/models', '--engine', 'webkit'],
      'https://example.test/',
    ),
  ).toEqual({
    docs: false,
    check: false,
    engine: 'webkit',
    url: 'http://localhost:4173/',
    modelsFrom: '.cache/models',
  });
  expect(parseColdstartArgs(['docs', '--check'])).toEqual({
    docs: true,
    check: true,
    engine: 'chromium',
  });
  expect(() => parseColdstartArgs([])).toThrow('no homepage');
  expect(() => parseColdstartArgs(['--url', 'ftp://example.test'])).toThrow('http or https');
  expect(() => parseColdstartArgs(['--url', 'not a url'])).toThrow();
  expect(() => parseColdstartArgs(['--engine', 'safari', '--url', 'http://a.test'])).toThrow(
    'chromium, webkit, firefox',
  );
  expect(() => parseColdstartArgs(['--url'])).toThrow('Missing value for --url');
  expect(() => parseColdstartArgs(['--fast'])).toThrow('Unknown option --fast');
});

test('converts bytes to transfer time at 50 Mbit/s', () => {
  // 50 Mbit/s is 6,250,000 bytes per second.
  expect(transferMs(6_250_000)).toBe(1_000);
  expect(transferMs(62_500_000)).toBe(10_000);
  expect(transferMs(1_250_000, 10)).toBe(1_000);
  expect(transferMs(0)).toBe(0);
});

test('picks the files a default photo run fetches and prefers the fp16 classifier', () => {
  expect(runModelFiles(source).map((file) => file.id)).toEqual([
    'det-fp32',
    'cls-fp16',
    'labels',
    'tax',
    'geo',
  ]);
  expect(() => runModelFiles({ ...source, default_detector: 'missing' })).toThrow('detector');
  expect(() =>
    runModelFiles({
      ...source,
      local_exports: {
        files: source.local_exports.files.filter((file) => file.role !== 'geofence'),
      },
    }),
  ).toThrow('geofence');
});

test('computes the T3 budget from manifest bytes plus ten seconds', () => {
  // 10 + 20 + 1 + 2 + 3 MB = 36,000,000 bytes, which is 5.76 s at 6,250,000 bytes/s.
  expect(t3BudgetMs(runModelFiles(source))).toBe(5_760 + 10_000);
  expect(t3BudgetMs([{ bytes: 125_000_000 }])).toBe(30_000);
  expect(t3BudgetMs([])).toBe(10_000);
});

test('recognises model hosts and maps a URL to a file in the folder', () => {
  expect(isModelUrl('https://huggingface.co/owner/repo/resolve/abc/onnx/model.onnx')).toBe(true);
  expect(isModelUrl('https://cdn-lfs.hf.co/repos/1/file')).toBe(true);
  expect(isModelUrl('https://cdn-lfs-us-1.huggingface.co/repos/1/file')).toBe(true);
  expect(isModelUrl('https://example.test/huggingface.co/model.onnx')).toBe(false);
  expect(isModelUrl('http://localhost:4173/assets/app.js')).toBe(false);
  expect(
    modelFilePath(
      '.cache/models',
      'https://huggingface.co/o/r/resolve/abc/onnx/model%20a.onnx?x=1',
    ),
  ).toBe('.cache/models/model a.onnx');
  expect(() => modelFilePath('.cache/models', 'https://huggingface.co/')).toThrow('file name');
});

test('names every step that is over budget', () => {
  expect(budgetViolations(report)).toEqual([]);
  expect(budgetViolations({ ...report, t1Ms: 3_001, t2Ms: 1_200, t3Ms: 31_000 })).toEqual([
    'T1 took 3001 ms, over the 3000 ms budget',
    'T2 took 1200 ms, over the 1000 ms budget',
    'T3 took 31000 ms, over the 30000 ms budget',
  ]);
  expect(budgetViolations({ ...report, t1Ms: 3_000, t2Ms: 1_000, t3Ms: 30_000 })).toEqual([]);
});

test('reports a live T3 without gating it, and skips T3 for other engines', () => {
  expect(budgetViolations({ ...report, modelsSource: 'huggingface', t3Ms: 400_000 })).toEqual([]);
  expect(
    budgetViolations({
      ...report,
      engine: 'webkit',
      network: null,
      t3Ms: null,
      budgets: { t1Ms: 3_000, t2Ms: 1_000, t3Ms: null },
    }),
  ).toEqual([]);
});

test('validates a stored report', () => {
  expect(parseColdstartReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
  expect(
    parseColdstartReport({ ...report, engine: 'webkit', network: null, t3Ms: null }),
  ).toMatchObject({ engine: 'webkit', network: null, t3Ms: null });
  expect(() => parseColdstartReport({ ...report, engine: 'safari' })).toThrow('engine');
  expect(() => parseColdstartReport({ ...report, t1Ms: -1 })).toThrow('t1Ms');
  expect(() => parseColdstartReport({ ...report, modelsSource: 'cdn' })).toThrow('modelsSource');
  expect(() => parseColdstartReport({ ...report, sensitiveElements: [1] })).toThrow(
    'sensitiveElements',
  );
  expect(() => parseColdstartReport(null)).toThrow('report must be an object');
});

test('renders the documentation table from a report', () => {
  expect(renderColdstartTable(report)).toBe(
    [
      '```text',
      '| Step | Time (ms) | Budget (ms) |',
      '| --- | ---: | ---: |',
      '| T1 first visit to drop zone | 2100 | 3000 |',
      '| T2 sample click to first species card | 640 | 1000 |',
      '| T3 folder to first species card | 21500 | 30000 |',
      '```',
      '',
      'Engine chromium, 50 Mbit/s down, 10 Mbit/s up, 20 ms latency, models from local folder, Test machine, arm64, 16 GB, 2026-11-06T18:00:00.000Z.',
    ].join('\n'),
  );
  expect(
    renderColdstartTable({
      ...report,
      engine: 'firefox',
      network: null,
      modelsSource: 'huggingface',
      t3Ms: null,
      budgets: { t1Ms: 3_000, t2Ms: 1_000, t3Ms: null },
    }),
  ).toContain('| T3 folder to first species card | not measured | not measured |');
});

test('replaces only the marked cold-start block', () => {
  const markdown =
    '# Benchmarks\n\n<!-- coldstart:results -->\nold\n<!-- /coldstart:results -->\n\nAfter.\n';
  expect(updateResultsBlock(markdown, 'new')).toBe(
    '# Benchmarks\n\n<!-- coldstart:results -->\nnew\n<!-- /coldstart:results -->\n\nAfter.\n',
  );
  expect(updateResultsBlock('# Benchmarks\n', 'new')).toBe(
    '# Benchmarks\n\n<!-- coldstart:results -->\nnew\n<!-- /coldstart:results -->\n',
  );
});

test('T3 runs only with the photo folder, and live only once the models are published', () => {
  const source = (status: string) => ({ local_exports: { publication: { status } } });
  expect(t3SkipReason({}, false, source('published'))).toContain('not in this checkout');
  expect(t3SkipReason({}, true, source('pending-publication'))).toContain('not published');
  expect(t3SkipReason({ modelsFrom: '.cache/models' }, true, source('pending-publication'))).toBe(
    undefined,
  );
  expect(t3SkipReason({}, true, source('published'))).toBe(undefined);
});
