import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  type BrowserContext,
  chromium,
  firefox,
  type Page,
  type Route,
  webkit,
} from '@playwright/test';
import manifest from '../../models/manifest.json' with { type: 'json' };
import { requiredModelRoles } from '../../src/app/models';
import { machineString } from '../bench/bench_photos';

export const ENGINES = ['chromium', 'webkit', 'firefox'] as const;
export type Engine = (typeof ENGINES)[number];

export const DOWNLOAD_MBIT = 50;
export const UPLOAD_MBIT = 10;
export const LATENCY_MS = 20;
export const T1_BUDGET_MS = 3_000;
export const T2_BUDGET_MS = 1_000;
export const T3_SLACK_MS = 10_000;
export const RESULTS_PATH = 'tools/bench/results/coldstart.json';
export const SAMPLE_FOLDER = 'tests/e2e/fixtures/photos12';
export const BENCHMARKS_DOC_PATH = 'docs/benchmarks.md';
export const RESULTS_BLOCK_START = '<!-- coldstart:results -->';
export const RESULTS_BLOCK_END = '<!-- /coldstart:results -->';
export const NOT_MEASURED = 'No measured run is committed yet.';

const SAMPLE_BUTTON = 'Try the sample';
const DROP_ZONE = 'section[aria-label="Folder intake"]';
const FOLDER_INPUT = 'input[aria-label="Folder files"]';
const SPECIES_CARD = 'article';
const ISOLATION_PROBE_MS = 10_000;
const STEP_TIMEOUT_MS = 60_000;
// An unthrottled live download of the whole model set has no budget, only this ceiling.
const LIVE_T3_TIMEOUT_MS = 900_000;
const SENSITIVE_KEY = 'coldstart-sensitive';

export type ColdstartArgs = {
  docs: boolean;
  check: boolean;
  url?: string;
  modelsFrom?: string;
  engine: Engine;
};

export type ColdstartReport = {
  generatedAt: string;
  machine: string;
  userAgent: string;
  engine: Engine;
  url: string;
  modelsSource: 'huggingface' | 'local';
  network: { downloadMbit: number; uploadMbit: number; latencyMs: number } | null;
  t1Ms: number;
  t2Ms: number;
  t3Ms: number | null;
  budgets: { t1Ms: number; t2Ms: number; t3Ms: number | null };
  crossOriginIsolated: boolean;
  singleThreadMessage: boolean;
  sensitiveElements: string[];
};

type ManifestFile = { id: string; role: string; bytes: number; precision?: string };
export type ManifestLike = {
  default_detector: string;
  local_exports: { files: readonly ManifestFile[] };
  local_detector_exports: { files: readonly ManifestFile[] };
};

function optionValue(argv: readonly string[], index: number): string {
  const value = argv[index];
  if (value === undefined) throw new Error(`Missing value for ${argv[index - 1] ?? 'option'}`);
  return value;
}

/** The homepage is only a fallback; a missing one is an error because no URL is guessed. */
export function parseColdstartArgs(argv: readonly string[], homepage?: string): ColdstartArgs {
  const docs = argv[0] === 'docs';
  const args = docs ? argv.slice(1) : argv;
  let check = false;
  let url: string | undefined;
  let modelsFrom: string | undefined;
  let engine: Engine = 'chromium';
  for (let index = 0; index < args.length; index++) {
    switch (args[index]) {
      case '--check':
        check = true;
        break;
      case '--url':
        url = optionValue(args, ++index);
        break;
      case '--models-from':
        modelsFrom = optionValue(args, ++index);
        break;
      case '--engine': {
        const value = optionValue(args, ++index);
        const match = ENGINES.find((name) => name === value);
        if (match === undefined) {
          throw new Error(`--engine must be one of ${ENGINES.join(', ')}, got ${value}`);
        }
        engine = match;
        break;
      }
      default:
        throw new Error(
          `Unknown option ${args[index]}. Usage: coldstart [--url <url>] [--models-from <dir>] [--engine chromium|webkit|firefox] [--check] | coldstart docs [--check]`,
        );
    }
  }
  if (docs) return { docs, check, engine };
  const target = url ?? homepage;
  if (target === undefined) {
    throw new Error('Pass --url <url>; package.json has no homepage to fall back on.');
  }
  const parsed = new URL(target);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`--url must be http or https, got ${target}`);
  }
  return {
    docs,
    check,
    engine,
    url: parsed.href,
    ...(modelsFrom === undefined ? {} : { modelsFrom }),
  };
}

/**
 * Why T3 cannot run, or undefined when it can. A live run downloads the exports from their
 * hosting, so it needs them published; `--models-from` serves them from disk instead.
 */
export function t3SkipReason(
  args: Pick<ColdstartArgs, 'modelsFrom'>,
  folderExists: boolean,
  source: { local_exports: { publication: { status: string } } } = manifest,
): string | undefined {
  if (!folderExists) return `${SAMPLE_FOLDER} is not in this checkout`;
  if (args.modelsFrom === undefined && source.local_exports.publication.status !== 'published') {
    return 'the browser model exports are not published yet; pass --models-from to run it locally';
  }
  return undefined;
}

/** Milliseconds a link of the given speed needs for this many bytes. */
export function transferMs(bytes: number, mbit = DOWNLOAD_MBIT): number {
  return (bytes * 8 * 1000) / (mbit * 1_000_000);
}

/**
 * The manifest entry for each role a default photo run fetches. The detector is the default one;
 * where a role has several precisions, the fp16 one is what the precision policy ships.
 */
export function runModelFiles(
  source: ManifestLike,
  roles: readonly string[] = requiredModelRoles({
    hasPhotos: true,
    hasVideos: false,
    hasAudio: false,
    mode: 'default',
  }),
): ManifestFile[] {
  return roles.map((role) => {
    const matches =
      role === 'detector'
        ? source.local_detector_exports.files.filter((file) => file.id === source.default_detector)
        : source.local_exports.files.filter((file) => file.role === role);
    const preferred = matches.length > 1 ? matches.filter((file) => file.precision === 'fp16') : [];
    const [file, ...rest] = preferred.length > 0 ? preferred : matches;
    if (file === undefined || rest.length > 0) {
      throw new Error(`Select exactly one manifest file for ${role}.`);
    }
    return file;
  });
}

/** The budget follows the files that run, so a new model changes it without an edit here. */
export function t3BudgetMs(files: readonly { bytes: number }[]): number {
  const bytes = files.reduce((total, file) => total + file.bytes, 0);
  return Math.ceil(transferMs(bytes)) + T3_SLACK_MS;
}

export function isModelUrl(url: string): boolean {
  const { hostname } = new URL(url);
  return (
    hostname === 'huggingface.co' ||
    hostname.endsWith('.huggingface.co') ||
    hostname === 'hf.co' ||
    hostname.endsWith('.hf.co')
  );
}

/** Folder files are matched by the name the model URL ends in. */
export function modelFilePath(directory: string, url: string): string {
  const name = basename(decodeURIComponent(new URL(url).pathname));
  if (name === '') throw new Error(`Cannot derive a file name from ${url}`);
  return join(directory, name);
}

export function budgetViolations(report: ColdstartReport): string[] {
  const rows: [string, number | null, number | null][] = [
    ['T1', report.t1Ms, report.budgets.t1Ms],
    ['T2', report.t2Ms, report.budgets.t2Ms],
    // Live downloads depend on the host's throughput, so only the local-model run is gated.
    ['T3', report.modelsSource === 'local' ? report.t3Ms : null, report.budgets.t3Ms],
  ];
  const problems: string[] = [];
  for (const [name, actual, budget] of rows) {
    if (actual !== null && budget !== null && actual > budget) {
      problems.push(`${name} took ${Math.round(actual)} ms, over the ${budget} ms budget`);
    }
  }
  return problems;
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function numberAt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a finite number >= 0`);
  }
  return value;
}

function nullableNumberAt(value: unknown, path: string): number | null {
  return value === null ? null : numberAt(value, path);
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`${path} must be a string`);
  return value;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`);
  return value;
}

/** Rejects hand-edited or partial result files before they reach the documentation table. */
export function parseColdstartReport(input: unknown): ColdstartReport {
  const root = objectAt(input, 'report');
  const budgets = objectAt(root.budgets, 'budgets');
  const engine = ENGINES.find((name) => name === root.engine);
  if (engine === undefined) throw new Error(`engine must be one of ${ENGINES.join(', ')}`);
  const modelsSource = root.modelsSource;
  if (modelsSource !== 'huggingface' && modelsSource !== 'local') {
    throw new Error('modelsSource must be huggingface or local');
  }
  let network: ColdstartReport['network'] = null;
  if (root.network !== null) {
    const value = objectAt(root.network, 'network');
    network = {
      downloadMbit: numberAt(value.downloadMbit, 'network.downloadMbit'),
      uploadMbit: numberAt(value.uploadMbit, 'network.uploadMbit'),
      latencyMs: numberAt(value.latencyMs, 'network.latencyMs'),
    };
  }
  if (
    !Array.isArray(root.sensitiveElements) ||
    root.sensitiveElements.some((item) => typeof item !== 'string')
  ) {
    throw new Error('sensitiveElements must be an array of strings');
  }
  return {
    generatedAt: stringAt(root.generatedAt, 'generatedAt'),
    machine: stringAt(root.machine, 'machine'),
    userAgent: stringAt(root.userAgent, 'userAgent'),
    engine,
    url: stringAt(root.url, 'url'),
    modelsSource,
    network,
    t1Ms: numberAt(root.t1Ms, 't1Ms'),
    t2Ms: numberAt(root.t2Ms, 't2Ms'),
    t3Ms: nullableNumberAt(root.t3Ms, 't3Ms'),
    budgets: {
      t1Ms: numberAt(budgets.t1Ms, 'budgets.t1Ms'),
      t2Ms: numberAt(budgets.t2Ms, 'budgets.t2Ms'),
      t3Ms: nullableNumberAt(budgets.t3Ms, 'budgets.t3Ms'),
    },
    crossOriginIsolated: booleanAt(root.crossOriginIsolated, 'crossOriginIsolated'),
    singleThreadMessage: booleanAt(root.singleThreadMessage, 'singleThreadMessage'),
    sensitiveElements: root.sensitiveElements as string[],
  };
}

function cell(value: number | null): string {
  return value === null ? 'not measured' : value.toFixed(0);
}

export function renderColdstartTable(report: ColdstartReport): string {
  const source = report.modelsSource === 'huggingface' ? 'Hugging Face (live)' : 'local folder';
  const link =
    report.network === null
      ? 'unthrottled'
      : `${report.network.downloadMbit} Mbit/s down, ${report.network.uploadMbit} Mbit/s up, ${report.network.latencyMs} ms latency`;
  return [
    '```text',
    '| Step | Time (ms) | Budget (ms) |',
    '| --- | ---: | ---: |',
    `| T1 first visit to drop zone | ${cell(report.t1Ms)} | ${cell(report.budgets.t1Ms)} |`,
    `| T2 sample click to first species card | ${cell(report.t2Ms)} | ${cell(report.budgets.t2Ms)} |`,
    `| T3 folder to first species card | ${cell(report.t3Ms)} | ${cell(report.budgets.t3Ms)} |`,
    '```',
    '',
    `Engine ${report.engine}, ${link}, models from ${source}, ${report.machine}, ${report.generatedAt}.`,
  ].join('\n');
}

export function updateResultsBlock(markdown: string, body: string): string {
  const start = markdown.indexOf(RESULTS_BLOCK_START);
  const end = markdown.indexOf(RESULTS_BLOCK_END);
  if (start >= 0 && end > start) {
    return `${markdown.slice(0, start)}${RESULTS_BLOCK_START}\n${body}\n${RESULTS_BLOCK_END}${markdown.slice(end + RESULTS_BLOCK_END.length)}`;
  }
  return `${markdown.trimEnd()}\n\n${RESULTS_BLOCK_START}\n${body}\n${RESULTS_BLOCK_END}\n`;
}

// Kept as source text: a transpiled function can reference helpers the page does not have.
const WATCH_SENSITIVE_ELEMENTS = `(() => {
  const key = ${JSON.stringify(SENSITIVE_KEY)};
  const scan = () => {
    try {
      const found = new Set(JSON.parse(sessionStorage.getItem(key) || '[]'));
      for (const element of document.querySelectorAll('input, dialog, [role=dialog], [role=alertdialog]')) {
        if (element.matches('input[type=password]')) found.add('input[type=password]');
        else if (element.matches('input[type=email]')) found.add('input[type=email]');
        else if (!element.matches('input') && /settings/i.test((element.getAttribute('aria-label') || '') + ' ' + element.textContent)) found.add('settings dialog');
      }
      sessionStorage.setItem(key, JSON.stringify([...found]));
    } catch {}
  };
  new MutationObserver(scan).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  document.addEventListener('DOMContentLoaded', scan);
})();`;

const browserTypes = { chromium, webkit, firefox } as const;

type Profile = { context: BrowserContext; page: Page; close(): Promise<void> };

/** A new temporary profile has no cache, service worker, IndexedDB or Cache Storage. */
async function openProfile(engine: Engine, modelsFrom: string | undefined): Promise<Profile> {
  const directory = await mkdtemp(join(tmpdir(), 'deerdiary-coldstart-'));
  let context: BrowserContext | undefined;
  try {
    context = await browserTypes[engine].launchPersistentContext(directory, { headless: true });
    const opened = context;
    opened.setDefaultTimeout(STEP_TIMEOUT_MS);
    await opened.addInitScript(WATCH_SENSITIVE_ELEMENTS);
    const missing = modelsFrom === undefined ? [] : await serveModels(opened, modelsFrom);
    const page = opened.pages()[0] ?? (await opened.newPage());
    if (engine === 'chromium') {
      const session = await opened.newCDPSession(page);
      await session.send('Network.enable');
      await session.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: LATENCY_MS,
        downloadThroughput: (DOWNLOAD_MBIT * 1_000_000) / 8,
        uploadThroughput: (UPLOAD_MBIT * 1_000_000) / 8,
      });
    }
    return {
      context: opened,
      page,
      async close() {
        try {
          await opened.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
        if (missing.length > 0) {
          throw new Error(`Model files missing from ${modelsFrom}: ${missing.join(', ')}`);
        }
      },
    };
  } catch (error) {
    await context?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Route-fulfilled responses skip CDP throttling, so the handler holds each one for the time the
 * download link would need. Responses queue, because one link is shared by every download.
 */
async function serveModels(context: BrowserContext, directory: string): Promise<string[]> {
  const missing: string[] = [];
  let queue: Promise<void> = Promise.resolve();
  await context.route(
    (url) => isModelUrl(url.href),
    async (route: Route) => {
      const url = route.request().url();
      const path = modelFilePath(directory, url);
      if (!existsSync(path)) {
        missing.push(basename(path));
        await route.fulfill({ status: 404, body: 'Not in the local model folder' });
        return;
      }
      const body = await readFile(path);
      const turn = queue.then(() => delay(transferMs(body.byteLength)));
      queue = turn.catch(() => {});
      await turn;
      await route.fulfill({
        status: 200,
        body,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Access-Control-Allow-Origin': '*',
          'Cross-Origin-Resource-Policy': 'cross-origin',
        },
      });
    },
  );
  return missing;
}

async function sensitiveElements(page: Page): Promise<string[]> {
  const stored = await page.evaluate((key) => sessionStorage.getItem(key), SENSITIVE_KEY);
  return stored === null ? [] : (JSON.parse(stored) as string[]);
}

/**
 * Chromium must be isolated by a controlled reload, so T1 waits for a document that is the
 * result of one; the other engines end T1 at the drop zone and report isolation afterwards.
 */
async function firstVisit(page: Page, url: string, engine: Engine): Promise<number> {
  const startedAt = performance.now();
  await page.goto(url, { waitUntil: 'commit' });
  if (engine === 'chromium') {
    await page.waitForFunction(
      () =>
        crossOriginIsolated &&
        (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)
          ?.type === 'reload',
    );
  }
  await page.locator(DROP_ZONE).waitFor({ state: 'visible' });
  return performance.now() - startedAt;
}

async function isolationAfterReload(page: Page): Promise<boolean> {
  try {
    await page.waitForFunction(() => crossOriginIsolated, undefined, {
      timeout: ISOLATION_PROBE_MS,
    });
    return true;
  } catch {
    return false;
  }
}

export async function runColdstart(
  args: ColdstartArgs & { url: string },
): Promise<ColdstartReport> {
  const throttled = args.engine === 'chromium';
  const files = runModelFiles(manifest);
  let t1Ms: number;
  let t2Ms: number;
  let isolated: boolean;
  let singleThread: boolean;
  let userAgent: string;
  const sensitive = new Set<string>();

  const first = await openProfile(args.engine, args.modelsFrom);
  try {
    t1Ms = await firstVisit(first.page, args.url, args.engine);
    isolated = await isolationAfterReload(first.page);
    userAgent = await first.page.evaluate(() => navigator.userAgent);
    singleThread = (await first.page.getByText(/single[- ]thread/i).count()) > 0;
    const startedAt = performance.now();
    await first.page.getByRole('button', { name: SAMPLE_BUTTON }).click();
    await first.page.locator(SPECIES_CARD).first().waitFor({ state: 'visible' });
    t2Ms = performance.now() - startedAt;
    for (const item of await sensitiveElements(first.page)) sensitive.add(item);
  } finally {
    await first.close();
  }

  let t3Ms: number | null = null;
  const skipReason = throttled ? t3SkipReason(args, existsSync(SAMPLE_FOLDER)) : undefined;
  if (skipReason !== undefined) console.error(`Skipping T3: ${skipReason}.`);
  if (throttled && skipReason === undefined) {
    const second = await openProfile(args.engine, args.modelsFrom);
    try {
      await firstVisit(second.page, args.url, args.engine);
      const startedAt = performance.now();
      await second.page.locator(FOLDER_INPUT).setInputFiles(SAMPLE_FOLDER);
      await second.page
        .locator(SPECIES_CARD)
        .first()
        .waitFor({
          state: 'visible',
          timeout: args.modelsFrom === undefined ? LIVE_T3_TIMEOUT_MS : STEP_TIMEOUT_MS * 5,
        });
      t3Ms = performance.now() - startedAt;
      for (const item of await sensitiveElements(second.page)) sensitive.add(item);
    } finally {
      await second.close();
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    machine: machineString(),
    userAgent,
    engine: args.engine,
    url: args.url,
    modelsSource: args.modelsFrom === undefined ? 'huggingface' : 'local',
    network: throttled
      ? { downloadMbit: DOWNLOAD_MBIT, uploadMbit: UPLOAD_MBIT, latencyMs: LATENCY_MS }
      : null,
    t1Ms: Math.round(t1Ms),
    t2Ms: Math.round(t2Ms),
    t3Ms: t3Ms === null ? null : Math.round(t3Ms),
    budgets: {
      t1Ms: T1_BUDGET_MS,
      t2Ms: T2_BUDGET_MS,
      t3Ms: t3Ms === null ? null : t3BudgetMs(files),
    },
    crossOriginIsolated: isolated,
    singleThreadMessage: singleThread,
    sensitiveElements: [...sensitive].sort(),
  };
}

async function homepage(): Promise<string | undefined> {
  const value = (JSON.parse(await readFile('package.json', 'utf8')) as { homepage?: unknown })
    .homepage;
  return typeof value === 'string' ? value : undefined;
}

async function runDocs(check: boolean): Promise<void> {
  const body = existsSync(RESULTS_PATH)
    ? renderColdstartTable(parseColdstartReport(JSON.parse(await readFile(RESULTS_PATH, 'utf8'))))
    : NOT_MEASURED;
  const markdown = await readFile(BENCHMARKS_DOC_PATH, 'utf8');
  const updated = updateResultsBlock(markdown, body);
  if (check) {
    if (updated !== markdown) {
      throw new Error(`${BENCHMARKS_DOC_PATH} is out of date. Run npm run docs:bench.`);
    }
    console.log(`${BENCHMARKS_DOC_PATH} matches ${RESULTS_PATH}`);
    return;
  }
  await writeFile(BENCHMARKS_DOC_PATH, updated);
  console.log(`Updated ${BENCHMARKS_DOC_PATH} from ${RESULTS_PATH}`);
}

if (import.meta.main) {
  const args = parseColdstartArgs(process.argv.slice(2), await homepage());
  if (args.docs) {
    await runDocs(args.check);
  } else if (args.url !== undefined) {
    if (args.modelsFrom !== undefined) await stat(args.modelsFrom);
    const report = await runColdstart({ ...args, url: args.url });
    await mkdir(dirname(RESULTS_PATH), { recursive: true });
    await writeFile(RESULTS_PATH, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    const problems = [
      ...report.sensitiveElements.map((name) => `The path showed a ${name}`),
      ...(args.check ? budgetViolations(report) : []),
    ];
    if (problems.length > 0) {
      for (const problem of problems) console.error(problem);
      process.exitCode = 1;
    }
  }
}
