import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { arch, cpus, homedir, tmpdir, totalmem } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { build } from 'vite';
import manifest from '../../models/manifest.json' with { type: 'json' };
import { defaultPhotoModelFiles, LOCAL_MODEL_PATH } from '../../src/app/models';
import { DEFAULT_INDEPENDENCE_INTERVAL_MIN } from '../../src/core/independence';
import { toSpeciesNetJson } from '../../src/core/speciesnetJson';
import { percentile } from './detector-metrics';
import { peakRssBytes, type RssPoint, readTreeRss, rssSlopeBytesPerPhoto } from './rss';

export const DEFAULT_CARD_DIR = 'tools/bench/data/card';
export const UPSCALED_CARD_DIR = '.cache/bench/card-12mp';
export const DEFAULT_COUNT = 10_000;
export const MIN_TRAIL_CAMERA_MP = 8;
export const UPSCALED_MP = 12;
export const UPSCALE_LABEL = `upscaled to ${UPSCALED_MP} MP to match decode cost`;
export const RSS_SLOPE_AFTER_PHOTOS = 2_000;
export const RSS_SAMPLE_INTERVAL_MS = 1_000;
// The report of the last measured run, copied here by hand so the table never shows unmeasured numbers.
export const MEASURED_RESULTS_PATH = 'docs/benchmarks.json';
export const NOT_MEASURED = 'No measured run is committed yet.';
export const BENCHMARKS_DOC_PATH = 'docs/benchmarks.md';
export const RESULTS_BLOCK_START = '<!-- bench:results -->';
export const RESULTS_BLOCK_END = '<!-- /bench:results -->';

const STAGE_NAMES = [
  'decode',
  'preprocess',
  'detect',
  'classify',
  'ensemble',
  'thumbnail',
  'total',
] as const;
type StageName = (typeof STAGE_NAMES)[number];
type BackendName = 'webgpu' | 'wasm';

export type PlannedPhoto = { index: number; source: string; benchPath: string };

export type StageTimes = Record<StageName, number>;

export type BackendReport = {
  backend: BackendName;
  actualBackend: BackendName;
  photos: number;
  failedPhotos: number;
  photosPerSecond: number;
  firstCardMs: number;
  stageMs: StageTimes;
  peakTreeRssBytes: number;
  rssSlopeBytesPerPhoto: number | null;
};

export type BenchmarkReport = {
  generatedAt: string;
  machine: string;
  chromeVersion: string;
  ortVersion: string;
  mode: 'default' | 'reference';
  country?: string;
  photos: {
    distinct: number;
    fed: number;
    medianMegapixels: number;
    upscaled: boolean;
  };
  backends: BackendReport[];
};

export type BenchArgs = {
  docs: boolean;
  check: boolean;
  wasm: boolean;
  files: string;
  count: number;
  mode: 'default' | 'reference';
  resultsPath: string;
  country?: string;
  exportPath?: string;
};

function optionValue(argv: readonly string[], index: number): string {
  const value = argv[index];
  if (value === undefined) throw new Error(`Missing value for ${argv[index - 1] ?? 'option'}`);
  return value;
}

export function parseBenchArgs(argv: readonly string[]): BenchArgs {
  const args = argv[0] === 'docs' ? argv.slice(1) : argv;
  const docs = argv[0] === 'docs';
  let check = false;
  let wasm = false;
  let files = DEFAULT_CARD_DIR;
  let count = DEFAULT_COUNT;
  let mode: 'default' | 'reference' = 'default';
  let resultsPath = docs ? MEASURED_RESULTS_PATH : join('.cache', 'bench', 'results.json');
  let country: string | undefined;
  let exportPath: string | undefined;
  for (let index = 0; index < args.length; index++) {
    switch (args[index]) {
      case '--check':
        check = true;
        break;
      case '--wasm':
        wasm = true;
        break;
      case '--files':
        files = optionValue(args, ++index);
        break;
      case '--count': {
        const value = optionValue(args, ++index);
        count = Number(value);
        if (!Number.isSafeInteger(count) || count < 1) {
          throw new Error(`--count must be a positive integer, got ${value}`);
        }
        break;
      }
      case '--mode': {
        const value = optionValue(args, ++index);
        if (value !== 'default' && value !== 'reference') {
          throw new Error(`--mode must be default or reference, got ${value}`);
        }
        mode = value;
        break;
      }
      case '--country': {
        const value = optionValue(args, ++index);
        if (!/^[A-Z]{3}$/.test(value))
          throw new Error(`--country must be an ISO 3166-1 alpha-3 code, got ${value}`);
        country = value;
        break;
      }
      case '--export':
        exportPath = optionValue(args, ++index);
        break;
      case '--results':
        resultsPath = optionValue(args, ++index);
        break;
      default:
        throw new Error(
          `Unknown option ${args[index]}. Usage: bench_photos [--files <dir>] [--count <n>] [--mode default|reference] [--country <ISO3>] [--export <path>] [--wasm] [--results <path>] | bench_photos docs [--check] [--results <path>]`,
        );
    }
  }
  return {
    docs,
    check,
    wasm,
    files,
    count,
    mode,
    resultsPath,
    ...(country === undefined ? {} : { country }),
    ...(exportPath === undefined ? {} : { exportPath }),
  };
}

/**
 * Each fed copy gets its own path, so the pipeline's file key never returns a cached result.
 * Export mode keeps the card's real paths and feeds each file once.
 */
export function planPhotos(
  files: readonly string[],
  count: number,
  keepRealPaths: boolean,
): PlannedPhoto[] {
  if (files.length === 0) throw new Error('No JPEG photos to feed');
  if (keepRealPaths) {
    return files.map((source, index) => ({ index, source, benchPath: source }));
  }
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error('Use a positive photo count');
  }
  return Array.from({ length: count }, (_, index) => {
    const source = files[index % files.length];
    if (source === undefined) throw new Error('Photo list changed while planning');
    return { index, source, benchPath: `bench/${index}/${basename(source)}` };
  });
}

const START_OF_FRAME = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function readU16(bytes: Uint8Array, at: number): number | undefined {
  const high = bytes[at];
  const low = bytes[at + 1];
  return high === undefined || low === undefined ? undefined : (high << 8) | low;
}

/** Reads the JPEG frame header; the benchmark only needs dimensions, not EXIF or pixels. */
export function jpegPixelSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    offset++;
    let marker = bytes[offset];
    offset++;
    while (marker === 0xff) {
      marker = bytes[offset];
      offset++;
    }
    if (marker === undefined) return undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = readU16(bytes, offset);
    if (length === undefined || length < 2) return undefined;
    if (START_OF_FRAME.has(marker)) {
      const height = readU16(bytes, offset + 3);
      const width = readU16(bytes, offset + 5);
      if (height === undefined || width === undefined || height === 0 || width === 0) {
        return undefined;
      }
      return { width, height };
    }
    offset += length;
  }
  return undefined;
}

export function medianMegapixels(sizes: readonly { width: number; height: number }[]): number {
  if (sizes.length === 0) throw new Error('No photo dimensions to summarize');
  const megapixels = sizes
    .map(({ width, height }) => (width * height) / 1_000_000)
    .sort((a, b) => a - b);
  const middle = Math.floor(megapixels.length / 2);
  if (megapixels.length % 2 === 1) return megapixels[middle] ?? 0;
  return ((megapixels[middle - 1] ?? 0) + (megapixels[middle] ?? 0)) / 2;
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function numberAt(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new Error(`${path} must be a finite number >= ${minimum}`);
  }
  return value;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`${path} must be a string`);
  return value;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`);
  return value;
}

function backendAt(value: unknown, path: string): BackendName {
  if (value !== 'webgpu' && value !== 'wasm') throw new Error(`${path} must be webgpu or wasm`);
  return value;
}

/** Rejects hand-edited or partial result files before they reach the documentation table. */
export function parseBenchmarkReport(input: unknown): BenchmarkReport {
  const root = objectAt(input, 'report');
  const photos = objectAt(root.photos, 'photos');
  if (!Array.isArray(root.backends) || root.backends.length === 0) {
    throw new Error('backends must be a nonempty array');
  }
  const backends = root.backends.map((value, index) => {
    const path = `backends[${index}]`;
    const backend = objectAt(value, path);
    const stageMs = objectAt(backend.stageMs, `${path}.stageMs`);
    const stages = Object.fromEntries(
      STAGE_NAMES.map((stage) => [stage, numberAt(stageMs[stage], `${path}.stageMs.${stage}`)]),
    ) as StageTimes;
    const slope = backend.rssSlopeBytesPerPhoto;
    return {
      backend: backendAt(backend.backend, `${path}.backend`),
      actualBackend: backendAt(backend.actualBackend, `${path}.actualBackend`),
      photos: numberAt(backend.photos, `${path}.photos`, 1),
      failedPhotos: numberAt(backend.failedPhotos, `${path}.failedPhotos`),
      photosPerSecond: numberAt(backend.photosPerSecond, `${path}.photosPerSecond`),
      firstCardMs: numberAt(backend.firstCardMs, `${path}.firstCardMs`),
      stageMs: stages,
      peakTreeRssBytes: numberAt(backend.peakTreeRssBytes, `${path}.peakTreeRssBytes`),
      rssSlopeBytesPerPhoto:
        slope === null ? null : numberAt(slope, `${path}.rssSlopeBytesPerPhoto`),
    };
  });
  const mode = root.mode;
  if (mode !== 'default' && mode !== 'reference') {
    throw new Error('mode must be default or reference');
  }
  const country = root.country;
  if (country !== undefined && typeof country !== 'string')
    throw new Error('country must be a string');
  return {
    generatedAt: stringAt(root.generatedAt, 'generatedAt'),
    machine: stringAt(root.machine, 'machine'),
    chromeVersion: stringAt(root.chromeVersion, 'chromeVersion'),
    ortVersion: stringAt(root.ortVersion, 'ortVersion'),
    mode,
    ...(country === undefined ? {} : { country }),
    photos: {
      distinct: numberAt(photos.distinct, 'photos.distinct', 1),
      fed: numberAt(photos.fed, 'photos.fed', 1),
      medianMegapixels: numberAt(photos.medianMegapixels, 'photos.medianMegapixels'),
      upscaled: booleanAt(photos.upscaled, 'photos.upscaled'),
    },
    backends,
  };
}

const GIB = 1024 ** 3;

export function renderBenchmarkTable(report: BenchmarkReport): string {
  const header =
    '| Backend | Photos/s | First card (ms) | Decode (ms) | Detector (ms) | Classifier (ms) | Ensemble (ms) | Peak tree RSS (GB) | RSS after 2,000 (MB/photo) |';
  const rule = '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |';
  const rows = report.backends.map(
    (run) =>
      `| ${run.backend} | ${run.photosPerSecond.toFixed(2)} | ${run.firstCardMs.toFixed(1)} | ${run.stageMs.decode.toFixed(1)} | ${run.stageMs.detect.toFixed(1)} | ${run.stageMs.classify.toFixed(1)} | ${run.stageMs.ensemble.toFixed(1)} | ${(run.peakTreeRssBytes / GIB).toFixed(2)} | ${
        run.rssSlopeBytesPerPhoto === null
          ? 'not measured'
          : (run.rssSlopeBytesPerPhoto / 1_000_000).toFixed(3)
      } |`,
  );
  return ['```text', header, rule, ...rows, '```'].join('\n');
}

export function updateResultsBlock(markdown: string, table: string): string {
  const start = markdown.indexOf(RESULTS_BLOCK_START);
  const end = markdown.indexOf(RESULTS_BLOCK_END);
  if (start >= 0 && end > start) {
    return `${markdown.slice(0, start)}${RESULTS_BLOCK_START}\n${table}\n${RESULTS_BLOCK_END}${markdown.slice(end + RESULTS_BLOCK_END.length)}`;
  }
  return `${markdown.trimEnd()}\n\n${RESULTS_BLOCK_START}\n${table}\n${RESULTS_BLOCK_END}\n`;
}

async function walkPhotos(directory: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) names.push(...(await walkPhotos(join(directory, entry.name), name)));
    else if (/\.jpe?g$/i.test(entry.name)) names.push(name);
  }
  return names.sort();
}

function photoPath(directory: string, name: string): string {
  return resolve(directory, ...name.split('/'));
}

async function cardMedianMegapixels(directory: string, names: readonly string[]): Promise<number> {
  const sizes = await Promise.all(
    names.map(async (name) => {
      const size = jpegPixelSize(await readFile(photoPath(directory, name)));
      if (size === undefined) throw new Error(`Cannot read JPEG dimensions from ${name}`);
      return size;
    }),
  );
  return medianMegapixels(sizes);
}

function localModelPath(id: string): string | undefined {
  for (const file of [...manifest.local_exports.files, ...manifest.local_detector_exports.files]) {
    if (file.id === id && file.local_path !== undefined) return file.local_path;
  }
  return undefined;
}

function cachePath(url: string): string {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  const [owner, repository, , revision, ...name] = parts;
  if (
    owner === undefined ||
    repository === undefined ||
    revision === undefined ||
    name.length === 0
  ) {
    throw new Error(`Cannot derive a cache path from ${url}`);
  }
  const cache = process.env.HF_HUB_CACHE ?? join(homedir(), '.cache', 'huggingface');
  return join(cache, `models--${owner}--${repository}`, 'snapshots', revision, ...name);
}

export function photoModelIds(mode: 'default' | 'reference'): Map<string, string> {
  const roles = new Map<string, string>(
    defaultPhotoModelFiles(manifest, true).map(({ role, url }) => [
      role,
      url.slice(LOCAL_MODEL_PATH.length),
    ]),
  );
  if (mode === 'reference') roles.set('detector', 'mdv5a');
  return roles;
}

async function modelPaths(mode: 'default' | 'reference'): Promise<Map<string, string>> {
  const paths = new Map<string, string>();
  for (const [role, id] of photoModelIds(mode)) {
    let path = localModelPath(id);
    if (path === undefined) {
      const upstream = manifest.files.find((file) => file.id === id);
      if (upstream === undefined) throw new Error(`No model file for ${role}`);
      path = cachePath(upstream.url);
    }
    try {
      await stat(path);
    } catch {
      throw new Error(
        `Missing ${role} model at ${path}. Download the model set or set HF_HUB_CACHE.`,
      );
    }
    paths.set(role, path);
  }
  return paths;
}

function driverSource(driverDirectory: string): string {
  const importPath = (path: string) => {
    const value = relative(driverDirectory, resolve(path)).split(sep).join('/');
    return value.startsWith('.') ? value : `./${value}`;
  };
  return `
import * as ort from 'onnxruntime-web/webgpu';
import { loadTaxonomy } from '${importPath('src/core/taxonomy.ts')}';
import { PhotoProcessor } from '${importPath('src/workers/photo.ts')}';
import { createPhotoModels } from '${importPath('src/workers/photo-ort.ts')}';

const STAGES = ['decode', 'preprocess', 'detect', 'classify', 'ensemble', 'thumbnail', 'total'];
const samples = Object.fromEntries(STAGES.map((stage) => [stage, []]));
const outputs = [];
let processor;
let done = 0;
let failed = 0;
let firstCardMs = null;
let startedAt = 0;
let country;
let collectOutputs = false;

async function asset(path, as) {
  const response = await fetch(path);
  if (!response.ok) throw new Error('Cannot load ' + path + ': HTTP ' + response.status);
  return as === 'json' ? response.json() : as === 'text' ? response.text() : response.arrayBuffer();
}

window.bench = {
  async init(config) {
    const [detector, classifier, labels, taxonomy, geofence] = await Promise.all([
      asset('/models/detector', 'bytes'),
      asset('/models/classifier', 'bytes'),
      asset('/models/classifier_labels', 'text'),
      asset('/models/taxonomy', 'text'),
      asset('/models/geofence', 'json'),
    ]);
    const models = await createPhotoModels(
      { detector: new Uint8Array(detector), classifier: new Uint8Array(classifier) },
      location.origin + '/',
      config.backend,
    );
    country = config.country;
    collectOutputs = config.collectOutputs;
    processor = new PhotoProcessor(models, labels.trim().split(/\\r?\\n/), {
      taxonomyMap: loadTaxonomy(taxonomy),
      geofenceMap: geofence,
    });
    return { backend: models.backend, ortVersion: ort.env.versions.common };
  },
  progress() {
    return { done, firstCardMs };
  },
  async run(paths) {
    startedAt = performance.now();
    for (let index = 0; index < paths.length; index++) {
      if (!processor) throw new Error('Initialize the photo processor first');
      const path = paths[index];
      const response = await fetch('/photos/' + index);
      if (!response.ok) throw new Error('Cannot load photo ' + index + ': HTTP ' + response.status);
      const blob = await response.blob();
      const file = new File([blob], path.split('/').pop() || 'photo.jpg', { type: 'image/jpeg' });
      const settings = country === undefined ? { path } : { path, country };
      const result = await processor.process({ file, settings });
      for (const stage of STAGES) samples[stage].push(result.ms[stage]);
      if (result.status === 'ok' && collectOutputs) {
        outputs.push({
          path: result.path,
          width: result.width,
          height: result.height,
          detections: result.detections,
        });
      } else failed++;
      done = index + 1;
      if (firstCardMs === null) firstCardMs = performance.now() - startedAt;
    }
    return { done, failed, firstCardMs, samples, outputs };
  },
};
`;
}

type DriverOutput = {
  path: string;
  width: number;
  height: number;
  detections: {
    category: string;
    label: string;
    conf: number;
    bbox: readonly [number, number, number, number];
    raw_classifications?: { classes: readonly string[]; scores: readonly number[] };
    processed_classification?: { class: string; score: number; source: string };
  }[];
};

type DriverSummary = {
  done: number;
  failed: number;
  firstCardMs: number | null;
  samples: Record<StageName, number[]>;
  outputs: DriverOutput[];
};

type Driver = {
  init(config: {
    backend: BackendName;
    country?: string;
    collectOutputs?: boolean;
  }): Promise<{ backend: BackendName; ortVersion: string }>;
  progress(): { done: number; firstCardMs: number | null };
  run(paths: readonly string[]): Promise<DriverSummary>;
};

type BenchServer = { url: string; close(): Promise<void> };

function contentHeaders(contentType: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}

async function startBenchServer(
  plan: readonly PlannedPhoto[],
  sourceDirectory: string,
  models: ReadonlyMap<string, string>,
): Promise<BenchServer> {
  const output = await mkdtemp(join(tmpdir(), 'deerdiary-bench-'));
  await mkdir(join('.cache', 'bench'), { recursive: true });
  const driverDirectory = await mkdtemp(join('.cache', 'bench', 'driver-'));
  const runtimeDirectory = 'node_modules/onnxruntime-web/dist';
  try {
    await writeFile(join(driverDirectory, 'driver.ts'), driverSource(driverDirectory));
    await build({
      publicDir: false,
      build: {
        outDir: output,
        emptyOutDir: true,
        watch: null,
        rolldownOptions: {
          input: join(driverDirectory, 'driver.ts'),
          output: { entryFileNames: 'driver.js' },
        },
      },
    });
    await mkdir(join(output, 'ort'));
    const runtimeAssets = (await readdir(runtimeDirectory)).filter(
      (name) => name.endsWith('.wasm') || name.endsWith('.mjs'),
    );
    await Promise.all(
      runtimeAssets.map((name) =>
        copyFile(join(runtimeDirectory, name), join(output, 'ort', name)),
      ),
    );
    const driver = await readFile(join(output, 'driver.js'));
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Photo benchmark</title></head><body><script type="module" src="/driver.js"></script></body></html>`;

    const serve = (
      path: string,
      contentType: string,
      response: import('node:http').ServerResponse,
    ) => {
      response.writeHead(200, contentHeaders(contentType));
      createReadStream(path)
        .on('error', () => response.destroy())
        .pipe(response);
    };
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/') {
        response.writeHead(200, contentHeaders('text/html; charset=utf-8'));
        response.end(html);
        return;
      }
      if (url.pathname === '/driver.js') {
        response.writeHead(200, contentHeaders('text/javascript; charset=utf-8'));
        response.end(driver);
        return;
      }
      if (url.pathname.startsWith('/ort/')) {
        const name = basename(url.pathname);
        const type = name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8';
        serve(join(runtimeDirectory, name), type, response);
        return;
      }
      if (url.pathname.startsWith('/models/')) {
        const path = models.get(url.pathname.slice('/models/'.length));
        if (path === undefined) {
          response.writeHead(404, contentHeaders('text/plain')).end();
          return;
        }
        serve(path, 'application/octet-stream', response);
        return;
      }
      if (url.pathname.startsWith('/photos/')) {
        const photo = plan[Number(url.pathname.slice('/photos/'.length))];
        if (photo === undefined) {
          response.writeHead(404, contentHeaders('text/plain')).end();
          return;
        }
        serve(photoPath(sourceDirectory, photo.source), 'image/jpeg', response);
        return;
      }
      response.writeHead(404, contentHeaders('text/plain')).end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Benchmark server did not expose a port');
    }
    return {
      url: `http://127.0.0.1:${address.port}/`,
      async close() {
        try {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        } finally {
          await Promise.all([
            rm(output, { recursive: true, force: true }),
            rm(driverDirectory, { recursive: true, force: true }),
          ]);
        }
      },
    };
  } catch (error) {
    await Promise.all([
      rm(output, { recursive: true, force: true }),
      rm(driverDirectory, { recursive: true, force: true }),
    ]);
    throw error;
  }
}

export function machineString(): string {
  const cpu = cpus()[0]?.model ?? arch();
  return `${cpu}, ${arch()}, ${(totalmem() / GIB).toFixed(0)} GB`;
}

async function benchmarkBackend(options: {
  backend: BackendName;
  plan: readonly PlannedPhoto[];
  sourceDirectory: string;
  models: ReadonlyMap<string, string>;
  collectOutputs: boolean;
  country?: string;
}): Promise<{
  report: BackendReport;
  outputs: DriverOutput[];
  chromeVersion: string;
  ortVersion: string;
}> {
  const server = await startBenchServer(options.plan, options.sourceDirectory, options.models);
  const browser = await chromium.launchServer({
    headless: false,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH === undefined
      ? {}
      : { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }),
  });
  const pid = browser.process().pid;
  if (pid === undefined) throw new Error('Chromium did not expose a process id');
  try {
    const client = await chromium.connect(browser.wsEndpoint());
    const page = await client.newPage();
    try {
      await page.goto(server.url);
      // A stale result keyed by a synthetic path must never be resumed.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            const request = indexedDB.deleteDatabase('deerdiary');
            request.onsuccess = () => resolve();
            request.onerror = () => resolve();
            request.onblocked = () => resolve();
          }),
      );
      const initialized = await page.evaluate(
        async (config) =>
          (
            window as unknown as {
              bench: Driver;
            }
          ).bench.init(config),
        {
          backend: options.backend,
          collectOutputs: options.collectOutputs,
          ...(options.country === undefined ? {} : { country: options.country }),
        },
      );
      const startedAt = performance.now();
      const run = page.evaluate(
        (paths) =>
          (
            window as unknown as {
              bench: Driver;
            }
          ).bench.run(paths),
        options.plan.map((photo) => photo.benchPath),
      );
      let finished = false;
      const points: RssPoint[] = [];
      let nextProgress = 100;
      void run.then(
        () => {
          finished = true;
        },
        () => {
          finished = true;
        },
      );
      while (!finished) {
        const rssBytes = await readTreeRss(pid);
        const progress = await page.evaluate(() =>
          (
            window as unknown as {
              bench: Driver;
            }
          ).bench.progress(),
        );
        if (options.collectOutputs && progress.done >= nextProgress) {
          console.log(`${options.backend}: ${progress.done}/${options.plan.length} photos`);
          nextProgress += 100;
        }
        points.push({ photos: progress.done, rssBytes });
        await delay(RSS_SAMPLE_INTERVAL_MS);
      }
      const summary = await run;
      const elapsedMs = performance.now() - startedAt;
      points.push({ photos: summary.done, rssBytes: await readTreeRss(pid) });
      const stageMs = Object.fromEntries(
        STAGE_NAMES.map((stage) => [stage, percentile(summary.samples[stage], 0.5)]),
      ) as StageTimes;
      return {
        report: {
          backend: options.backend,
          actualBackend: initialized.backend,
          photos: summary.done,
          failedPhotos: summary.failed,
          photosPerSecond: (summary.done / elapsedMs) * 1_000,
          firstCardMs: summary.firstCardMs ?? 0,
          stageMs,
          peakTreeRssBytes: peakRssBytes(points),
          rssSlopeBytesPerPhoto: rssSlopeBytesPerPhoto(points, RSS_SLOPE_AFTER_PHOTOS),
        },
        outputs: summary.outputs,
        chromeVersion: await client.version(),
        ortVersion: initialized.ortVersion,
      };
    } finally {
      await page.close();
      await client.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

async function listUpscaled(directory: string): Promise<string[]> {
  try {
    await stat(directory);
  } catch {
    throw new Error(
      `No upscaled photos in ${directory}. Run python tools/bench/upscale.py before the 10,000-photo run.`,
    );
  }
  const names = await walkPhotos(directory);
  if (names.length === 0) {
    throw new Error(
      `No upscaled photos in ${directory}. Run python tools/bench/upscale.py before the 10,000-photo run.`,
    );
  }
  return names;
}

export async function runPhotoBenchmark(args: BenchArgs): Promise<BenchmarkReport> {
  const exportMode = args.exportPath !== undefined;
  const cardDirectory = resolve(args.files);
  try {
    await stat(cardDirectory);
  } catch {
    throw new Error(`No card at ${cardDirectory}. Pass --files <dir>.`);
  }
  const cardNames = await walkPhotos(cardDirectory);
  if (cardNames.length === 0) throw new Error(`No JPEG photos in ${cardDirectory}`);
  const cardMedian = await cardMedianMegapixels(cardDirectory, cardNames);
  const upscaled = !exportMode && cardMedian < MIN_TRAIL_CAMERA_MP;
  const sourceDirectory = upscaled ? resolve(UPSCALED_CARD_DIR) : cardDirectory;
  const names = upscaled ? await listUpscaled(sourceDirectory) : cardNames;
  const median = await cardMedianMegapixels(sourceDirectory, names);
  const plan = planPhotos(names, args.count, exportMode);
  const models = await modelPaths(args.mode);
  const backends: BackendName[] = args.wasm
    ? ['wasm']
    : exportMode
      ? ['webgpu']
      : ['webgpu', 'wasm'];
  const runs: BackendReport[] = [];
  let firstRun: { outputs: DriverOutput[]; chromeVersion: string; ortVersion: string } | undefined;
  for (const backend of backends) {
    const result = await benchmarkBackend({
      backend,
      plan,
      sourceDirectory,
      models,
      collectOutputs: exportMode,
      ...(args.country === undefined ? {} : { country: args.country }),
    });
    runs.push(result.report);
    firstRun ??= {
      outputs: result.outputs,
      chromeVersion: result.chromeVersion,
      ortVersion: result.ortVersion,
    };
  }
  if (firstRun === undefined) throw new Error('No benchmark backend completed');
  const report: BenchmarkReport = {
    generatedAt: new Date().toISOString(),
    machine: machineString(),
    chromeVersion: firstRun.chromeVersion,
    ortVersion: firstRun.ortVersion,
    mode: args.mode,
    ...(args.country === undefined ? {} : { country: args.country }),
    photos: {
      distinct: new Set(plan.map((photo) => photo.source)).size,
      fed: plan.length,
      medianMegapixels: median,
      upscaled,
    },
    backends: runs,
  };
  await mkdir(dirname(args.resultsPath), { recursive: true });
  await writeFile(args.resultsPath, `${JSON.stringify(report, null, 2)}\n`);
  if (args.exportPath !== undefined) {
    const predictions = firstRun.outputs.map((output) => ({
      filepath: output.path,
      ...(args.country === undefined ? {} : { country: args.country }),
      detections: output.detections,
    }));
    await mkdir(dirname(args.exportPath), { recursive: true });
    await writeFile(
      args.exportPath,
      toSpeciesNetJson({
        predictions,
        events: [],
        corrections: {},
        independenceIntervalMin: DEFAULT_INDEPENDENCE_INTERVAL_MIN,
      }),
    );
  }
  if (upscaled) console.log(UPSCALE_LABEL);
  return report;
}

async function runDocs(args: BenchArgs): Promise<void> {
  const table = existsSync(args.resultsPath)
    ? renderBenchmarkTable(
        parseBenchmarkReport(JSON.parse(await readFile(args.resultsPath, 'utf8'))),
      )
    : NOT_MEASURED;
  const markdown = await readFile(BENCHMARKS_DOC_PATH, 'utf8');
  const updated = updateResultsBlock(markdown, table);
  if (args.check) {
    if (updated !== markdown) {
      throw new Error(`${BENCHMARKS_DOC_PATH} is out of date. Run npm run docs:bench.`);
    }
    console.log(`${BENCHMARKS_DOC_PATH} matches ${args.resultsPath}`);
    return;
  }
  await writeFile(BENCHMARKS_DOC_PATH, updated);
  console.log(`Updated ${BENCHMARKS_DOC_PATH} from ${args.resultsPath}`);
}

if (import.meta.main) {
  const args = parseBenchArgs(process.argv.slice(2));
  if (args.docs) {
    await runDocs(args);
  } else {
    const report = await runPhotoBenchmark(args);
    console.log(JSON.stringify(report, null, 2));
  }
}
