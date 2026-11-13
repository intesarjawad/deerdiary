import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { type Plugin, preview } from 'vite';
import manifest from '../../models/manifest.json' with { type: 'json' };
import { defaultPhotoModelFiles, ModelUnpublishedError } from '../../src/app/models';
import { openApp } from '../../tests/fixtures/app';

/**
 * Writes the instant sample's `predictions.json` and `thumbs/` by dropping `public/sample/` on the
 * built app in headless Chromium, which runs the models on WASM, so the sample is exactly what the
 * app produces. Published model files that have a local export are served from disk.
 */

const SAMPLE_DIR = 'public/sample';
const PREDICTIONS_PATH = `${SAMPLE_DIR}/predictions.json`;
const THUMBNAILS_DIR = `${SAMPLE_DIR}/thumbs`;
// The folder name becomes the first part of every photo path, which the sample loader resolves
// against the app base to the photo itself.
const DROPPED_FOLDER = 'sample';
// A fixed session id and clock keep the committed file identical between runs. The clock must
// read later than every capture time, or the app flags the camera clock as wrong.
const SESSION_ID: ReturnType<Crypto['randomUUID']> = '00000000-0000-4000-8000-000000000000';
const SESSION_CREATED_MS = Date.UTC(2026, 10, 9);
const FILE_MTIME_S = 0;
const PROCESSING_TIMEOUT_MS = 1_800_000;
// The app guesses the country from the time zone. The sample's camera is in the southwestern
// United States, and a pinned zone keeps the geographic step the same on every machine.
const SAMPLE_TIME_ZONE = 'America/Los_Angeles';
// Local model copies are served by the preview server itself, because the page's
// `connect-src 'self'` admits that origin and a routed response body is capped at 100 MB.
const LOCAL_MODELS_PATH = '/local-models/';
const TEMPORARY_REDIRECT = 307;

type Thumbnail = { path: string; bytes: number[] };

type LocalModel = { url: string; path: string; servedAt: string };

function localModels(): LocalModel[] {
  const exported = [...manifest.local_exports.files, ...manifest.local_detector_exports.files];
  return defaultPhotoModelFiles().flatMap(({ url, sha256 }) => {
    const local = exported.find((file) => file.sha256 === sha256);
    return local
      ? [{ url, path: local.local_path, servedAt: `${LOCAL_MODELS_PATH}${sha256}` }]
      : [];
  });
}

function serveLocalModels(models: readonly LocalModel[]): Plugin {
  return {
    name: 'local-models',
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        const model = models.find(({ servedAt }) => servedAt === request.url);
        if (!model) return next();
        // A redirect from another origin leaves the request with an opaque origin.
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Content-Type', 'application/octet-stream');
        createReadStream(model.path)
          .on('error', () => response.destroy())
          .pipe(response);
      });
    },
  };
}

async function stageCard(photos: readonly string[]): Promise<string> {
  const card = join(await mkdtemp(join(tmpdir(), 'deerdiary-sample-')), DROPPED_FOLDER);
  await mkdir(card);
  for (const name of photos) {
    await copyFile(join(SAMPLE_DIR, name), join(card, name));
    // "Run it in this tab" builds its files with time 0, so its resume keys match these.
    await utimes(join(card, name), FILE_MTIME_S, FILE_MTIME_S);
  }
  return card;
}

async function storedThumbnails(page: Page): Promise<Thumbnail[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('deerdiary');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const results = await new Promise<{ output: { path: string; thumbnail?: Blob } }[]>(
      (resolve, reject) => {
        const request = database.transaction('results').objectStore('results').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      },
    );
    database.close();
    return Promise.all(
      results.flatMap(({ output: { path, thumbnail } }) =>
        thumbnail
          ? [
              thumbnail
                .arrayBuffer()
                .then((buffer) => ({ path, bytes: Array.from(new Uint8Array(buffer)) })),
            ]
          : [],
      ),
    );
  });
}

async function predict(
  photos: readonly string[],
  card: string,
  baseUrl: string,
  models: readonly LocalModel[],
): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      acceptDownloads: true,
      timezoneId: SAMPLE_TIME_ZONE,
    });
    for (const { url, servedAt } of models) {
      await context.route(url, (route) =>
        route.fulfill({
          status: TEMPORARY_REDIRECT,
          headers: {
            Location: new URL(servedAt, baseUrl).href,
            'Access-Control-Allow-Origin': '*',
          },
        }),
      );
    }
    const page = await context.newPage();
    await page.addInitScript((id) => {
      crypto.randomUUID = () => id;
      // The directory input is the intake every engine can be driven through.
      Object.defineProperty(window, 'showDirectoryPicker', {
        configurable: true,
        value: undefined,
      });
    }, SESSION_ID);
    await openApp(page, baseUrl);
    // The session's creation time is read when the folder is dropped.
    await page.clock.setFixedTime(SESSION_CREATED_MS);

    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Choose a folder' }).click();
    await (await chooser).setFiles(card);
    const finished = page.getByText(`${photos.length} / ${photos.length} photos`);
    const failed = page.getByRole('alert');
    await finished.or(failed).first().waitFor({ timeout: PROCESSING_TIMEOUT_MS });
    if (await failed.isVisible()) throw new Error(`The app stopped: ${await failed.textContent()}`);

    const history = page.getByRole('region', { name: 'History' });
    await history.getByRole('article').waitFor();
    const downloading = page.waitForEvent('download');
    await history.getByRole('button', { name: 'Export this session' }).click();
    const exported = await (await downloading).path();
    await writeFile(PREDICTIONS_PATH, await readFile(exported));

    const thumbnails = await storedThumbnails(page);
    if (thumbnails.length !== photos.length) {
      throw new Error(`The app stored ${thumbnails.length} previews for ${photos.length} photos.`);
    }
    await rm(THUMBNAILS_DIR, { recursive: true, force: true });
    await mkdir(THUMBNAILS_DIR);
    for (const { path, bytes } of thumbnails) {
      const name = path.slice(path.lastIndexOf('/') + 1);
      await writeFile(join(THUMBNAILS_DIR, name), Uint8Array.from(bytes));
    }
  } finally {
    await browser.close();
  }
}

if (import.meta.main) {
  try {
    defaultPhotoModelFiles();
  } catch (error) {
    if (!(error instanceof ModelUnpublishedError)) throw error;
    console.error(
      `The ${error.fileRole} has no published URL in models/manifest.json, so the app cannot run the default models. Publish the exports, add them to "files", then run this again.`,
    );
    process.exit(1);
  }
  const photos = (await readdir(SAMPLE_DIR)).filter((name) => name.endsWith('.jpg')).sort();
  if (photos.length === 0) {
    console.error(`${SAMPLE_DIR} has no photos. Run tools/sample/make_demo_card.py first.`);
    process.exit(1);
  }
  execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
  const card = await stageCard(photos);
  const models = localModels();
  const server = await preview({
    plugins: [serveLocalModels(models)],
    preview: { host: '127.0.0.1', port: 0, open: false },
  });
  try {
    const baseUrl = server.resolvedUrls?.local[0];
    if (!baseUrl) throw new Error('The preview server did not start.');
    await predict(photos, card, baseUrl, models);
    console.log(`Wrote ${PREDICTIONS_PATH} and ${photos.length} previews in ${THUMBNAILS_DIR}/`);
  } finally {
    await server.close();
    await rm(join(card, '..'), { recursive: true, force: true });
  }
}
