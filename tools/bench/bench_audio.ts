import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { machineString } from './bench_photos';
import { peakRssBytes, type RssPoint, readTreeRss } from './rss';

export const DEFAULT_AUDIO_DIR = 'tools/bench/data/audio';
export const DEFAULT_AUDIO_COUNT = 1_000;
const SAMPLE_INTERVAL_MS = 1_000;
const AUDIO_EXTENSIONS = new Set(['.wav', '.flac', '.mp3', '.ogg', '.m4a']);

export type AudioArgs = {
  files: string;
  count: number;
  resultsPath: string;
};

export type AudioReport = {
  generatedAt: string;
  machine: string;
  chromeVersion: string;
  files: { distinct: number; fed: number; bytes: number; seconds: number };
  filesPerSecond: number;
  secondsOfAudioPerSecond: number;
  failedFiles: number;
  peakTreeRssBytes: number;
};

function optionValue(argv: readonly string[], index: number): string {
  const value = argv[index];
  if (value === undefined) throw new Error(`Missing value for ${argv[index - 1] ?? 'option'}`);
  return value;
}

export function parseAudioArgs(argv: readonly string[]): AudioArgs {
  let files = DEFAULT_AUDIO_DIR;
  let count = DEFAULT_AUDIO_COUNT;
  let resultsPath = join('.cache', 'bench', 'audio.json');
  for (let index = 0; index < argv.length; index++) {
    switch (argv[index]) {
      case '--files':
        files = optionValue(argv, ++index);
        break;
      case '--count': {
        const value = optionValue(argv, ++index);
        count = Number(value);
        if (!Number.isSafeInteger(count) || count < 1) {
          throw new Error(`--count must be a positive integer, got ${value}`);
        }
        break;
      }
      case '--results':
        resultsPath = optionValue(argv, ++index);
        break;
      default:
        throw new Error(
          `Unknown option ${argv[index]}. Usage: bench_audio [--files <dir>] [--count <n>] [--results <path>]`,
        );
    }
  }
  return { files, count, resultsPath };
}

async function listAudio(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => {
      const extension = entry.name.toLowerCase().match(/\.[^.]+$/)?.[0];
      return entry.isFile() && extension !== undefined && AUDIO_EXTENSIONS.has(extension);
    })
    .map((entry) => entry.name)
    .sort();
}

// An OfflineAudioContext decodes without an output device or autoplay permission.
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Audio benchmark</title></head><body>
<script>
const context = new OfflineAudioContext(1, 1, 48000);
let done = 0;
let failed = 0;
window.audioBench = {
  progress() {
    return { done, failed };
  },
  async run(count) {
    const durations = [];
    for (let index = 0; index < count; index++) {
      const response = await fetch('/audio/' + index);
      if (!response.ok) throw new Error('Cannot load audio ' + index + ': HTTP ' + response.status);
      const bytes = await response.arrayBuffer();
      try {
        const buffer = await context.decodeAudioData(bytes);
        durations.push(buffer.duration);
      } catch {
        failed++;
      }
      done = index + 1;
    }
    return { done, failed, durations };
  },
};
</script></body></html>`;

type DecodeResult = {
  chromeVersion: string;
  elapsedMs: number;
  done: number;
  failed: number;
  durations: number[];
  points: RssPoint[];
};

async function decodeAudio(options: {
  plan: readonly string[];
  sourceDirectory: string;
}): Promise<DecodeResult> {
  const headers = {
    'Cache-Control': 'no-store',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') {
      response.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
      response.end(PAGE);
      return;
    }
    if (url.pathname.startsWith('/audio/')) {
      const name = options.plan[Number(url.pathname.slice('/audio/'.length))];
      if (name === undefined) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream' });
      createReadStream(join(options.sourceDirectory, name))
        .on('error', () => response.destroy())
        .pipe(response);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  try {
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Audio server did not expose a port');
    const browser = await chromium.launchServer({ headless: true });
    try {
      const pid = browser.process().pid;
      if (pid === undefined) throw new Error('Chromium did not expose a process id');
      const client = await chromium.connect(browser.wsEndpoint());
      try {
        const page = await client.newPage();
        try {
          await page.goto(`http://127.0.0.1:${address.port}/`);
          const startedAt = performance.now();
          const run = page.evaluate(
            (count) =>
              (
                window as unknown as {
                  audioBench: {
                    run(count: number): Promise<{
                      done: number;
                      failed: number;
                      durations: number[];
                    }>;
                  };
                }
              ).audioBench.run(count),
            options.plan.length,
          );
          let finished = false;
          const points: RssPoint[] = [];
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
                  audioBench: { progress(): { done: number; failed: number } };
                }
              ).audioBench.progress(),
            );
            points.push({ photos: progress.done, rssBytes });
            await delay(SAMPLE_INTERVAL_MS);
          }
          const result = await run;
          points.push({ photos: result.done, rssBytes: await readTreeRss(pid) });
          return {
            chromeVersion: await client.version(),
            elapsedMs: performance.now() - startedAt,
            done: result.done,
            failed: result.failed,
            durations: result.durations,
            points,
          };
        } finally {
          await page.close();
        }
      } finally {
        await client.close();
      }
    } finally {
      await browser.close();
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

export async function runAudioBenchmark(args: AudioArgs): Promise<AudioReport> {
  const sourceDirectory = resolve(args.files);
  try {
    await stat(sourceDirectory);
  } catch {
    throw new Error(`No audio directory at ${sourceDirectory}. Pass --files <dir>.`);
  }
  const names = await listAudio(sourceDirectory);
  if (names.length === 0) throw new Error(`No audio files in ${sourceDirectory}`);
  const plan = Array.from({ length: args.count }, (_, index) => {
    const name = names[index % names.length];
    if (name === undefined) throw new Error('Audio list changed while planning');
    return name;
  });
  const bytes = (
    await Promise.all(
      Array.from(new Set(names), async (name) => (await stat(join(sourceDirectory, name))).size),
    )
  ).reduce((total, size) => total + size, 0);
  const decoded = await decodeAudio({ plan, sourceDirectory });
  const seconds = decoded.durations.reduce((total, duration) => total + duration, 0);
  const elapsedSeconds = decoded.elapsedMs / 1_000;
  const report: AudioReport = {
    generatedAt: new Date().toISOString(),
    machine: machineString(),
    chromeVersion: decoded.chromeVersion,
    files: { distinct: names.length, fed: plan.length, bytes, seconds },
    filesPerSecond: decoded.done / elapsedSeconds,
    secondsOfAudioPerSecond: seconds / elapsedSeconds,
    failedFiles: decoded.failed,
    peakTreeRssBytes: peakRssBytes(decoded.points),
  };
  await mkdir(dirname(args.resultsPath), { recursive: true });
  await writeFile(args.resultsPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (import.meta.main) {
  const report = await runAudioBenchmark(parseAudioArgs(process.argv.slice(2)));
  console.log(JSON.stringify(report, null, 2));
}
