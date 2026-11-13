import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, type Page } from '@playwright/test';
import type { DeerdiaryEvent, PhotoResult } from '../../src/core/types';
import { openApp } from '../fixtures/app';
import { browserModule } from '../fixtures/browser-module';
import type * as harness from '../fixtures/reel-harness';
import { test } from '../fixtures/storage';

const run = promisify(execFile);

// The service worker answers from this cache, so a controlled page can import a module put there.
const SHELL_CACHE = 'deerdiary-shell-v1';
const DURATION_TOLERANCE_S = 0.1;
const END_CARD_FRAME_S = 10.6;
const FIRST_SHOT_FRAME_S = 0.6;
// The card is near-black with light text; every test photo is a bright flat colour.
const END_CARD_MAX_MEAN_LUMA = 64;
const SHOT_MIN_MEAN_LUMA = 128;

const deer = 'deer-id;mammalia;artiodactyla;cervidae;odocoileus;virginianus;white-tailed deer';
const fox = 'fox-id;mammalia;carnivora;canidae;vulpes;vulpes;red fox';
const badger = 'badger-id;mammalia;carnivora;mustelidae;meles;meles;eurasian badger';
const hare = 'hare-id;mammalia;lagomorpha;leporidae;lepus;europaeus;european hare';
const labels = [deer, deer, deer, fox, fox, badger, hare, deer];
const colours = [
  '#f4d35e',
  '#ee964b',
  '#f95738',
  '#7bdff2',
  '#b2f7ef',
  '#eff7f6',
  '#f7d6e0',
  '#c5e99b',
];
const start = Date.UTC(2026, 2, 1, 6);
const hour = 3_600_000;

function shotEvent(label: string, index: number): DeerdiaryEvent {
  const wallClockMs = start + index * hour;
  const photo: PhotoResult = {
    path: `cam/shot-${index}.jpg`,
    time: {
      wallClockMs,
      wallClockHour: new Date(wallClockMs).getUTCHours(),
      timeSource: 'exif',
      offsetTimeOriginal: null,
      clockStatus: 'ok',
    },
    detections: [
      {
        category: '1',
        conf: 0.9,
        bbox: [0, 0, 0.5, 0.5],
        processed_classification: { class: label, score: 0.9, source: 'classifier' },
      },
    ],
  };
  return { cameraKey: 'cam', photos: [photo], species: [{ label, bestPhoto: photo }] };
}

async function mountReel(page: Page, baseURL: string | undefined) {
  if (!baseURL) throw new Error('Reel tests require baseURL.');
  await openApp(page);
  const url = new URL('reel-test/harness.js', baseURL).href;
  const code = await browserModule('tests/fixtures/reel-harness.ts');
  await page.evaluate(
    async ({ url, code, cacheName, events, colours }) => {
      const cache = await caches.open(cacheName);
      await cache.put(url, new Response(code, { headers: { 'Content-Type': 'text/javascript' } }));
      const module: typeof harness = await import(url);
      const photos = new Map<string, Blob>();
      for (const [index, event] of events.entries()) {
        const path = event.photos[0]?.path;
        const colour = colours[index];
        if (path === undefined || colour === undefined) throw new Error('Missing test photo.');
        photos.set(path, await module.flatPhoto(colour));
      }
      const root = document.createElement('div');
      document.body.append(root);
      module.mountReel(root, events, photos);
    },
    { url, code, cacheName: SHELL_CACHE, events: labels.map(shotEvent), colours },
  );
}

async function exportReel(page: Page, directory: string): Promise<string> {
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export reel' }).click();
  const download = await downloading;
  const path = `${directory}/${download.suggestedFilename()}`;
  await download.saveAs(path);
  return path;
}

async function probe(path: string): Promise<{ duration: number; codecs: string[] }> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration:stream=codec_name',
    '-of',
    'json',
    path,
  ]);
  const parsed: { format: { duration: string }; streams: { codec_name: string }[] } =
    JSON.parse(stdout);
  return {
    duration: Number(parsed.format.duration),
    codecs: parsed.streams.map((stream) => stream.codec_name),
  };
}

async function grabFrame(path: string, seconds: number, png: string): Promise<number> {
  const at = ['-v', 'error', '-ss', String(seconds), '-i', path, '-frames:v', '1'];
  await run('ffmpeg', [...at, '-y', png]);
  const { stdout } = await run(
    'ffmpeg',
    [...at, '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    { encoding: 'buffer' },
  );
  const luma = stdout[0];
  if (luma === undefined) throw new Error(`ffmpeg returned no frame at ${seconds} s.`);
  return luma;
}

test('exports an 11.6 s reel that ends on the card, and 9.6 s without the card', async ({
  page,
  baseURL,
  browserName,
}, testInfo) => {
  await mountReel(page, baseURL);
  const note = page.getByText('Reel export is not supported in this browser.');
  const button = page.getByRole('button', { name: 'Export reel' });
  await expect(note.or(button)).toBeVisible();
  if (await note.isVisible()) {
    // Only an engine with neither H.264 WebCodecs nor MediaRecorder may show the note.
    expect(browserName).toBe('webkit');
    await expect(button).toHaveCount(0);
    testInfo.annotations.push({ type: 'reel export', description: 'not supported' });
    return;
  }
  const codecs = browserName === 'chromium' ? ['h264'] : ['h264', 'vp8', 'vp9'];

  const withCard = await exportReel(page, testInfo.outputPath('with-card'));
  const full = await probe(withCard);
  expect(full.codecs).toHaveLength(1);
  expect(codecs).toContain(full.codecs[0]);
  expect(Math.abs(full.duration - 11.6)).toBeLessThanOrEqual(DURATION_TOLERANCE_S);
  testInfo.annotations.push({ type: 'reel codec', description: full.codecs.join(', ') });

  const cardPng = testInfo.outputPath('end-card.png');
  expect(await grabFrame(withCard, END_CARD_FRAME_S, cardPng)).toBeLessThan(END_CARD_MAX_MEAN_LUMA);
  await testInfo.attach('end card at 10.6 s', { path: cardPng, contentType: 'image/png' });
  expect(
    await grabFrame(withCard, FIRST_SHOT_FRAME_S, testInfo.outputPath('first-shot.png')),
  ).toBeGreaterThan(SHOT_MIN_MEAN_LUMA);

  await page.getByRole('checkbox', { name: 'Include end card' }).uncheck();
  const withoutCard = await exportReel(page, testInfo.outputPath('without-card'));
  const short = await probe(withoutCard);
  expect(short.codecs).toEqual(full.codecs);
  expect(Math.abs(short.duration - 9.6)).toBeLessThanOrEqual(DURATION_TOLERANCE_S);
});

test('the keyboard pauses the reel and moves through the shots and the card', async ({
  page,
  baseURL,
}) => {
  await mountReel(page, baseURL);
  const reel = page.getByRole('slider', { name: 'Species reel' });

  await reel.focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await page.keyboard.press('Home');
  await expect(reel).toHaveAttribute('aria-valuenow', '1');
  await expect(reel).toHaveAttribute('aria-valuemax', '9');
  await page.keyboard.press('ArrowRight');
  await expect(reel).toHaveAttribute('aria-valuenow', '2');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(reel).toHaveAttribute('aria-valuenow', '9');
  await expect(reel).toHaveAttribute(
    'aria-valuetext',
    /^End card\. Deerdiary\. white-tailed deer: 4/,
  );
  await page.keyboard.press('Home');
  await expect(reel).toHaveAttribute('aria-valuenow', '1');
  await page.keyboard.press('End');
  await expect(reel).toHaveAttribute('aria-valuenow', '9');

  await page.getByRole('checkbox', { name: 'Include end card' }).press('Space');
  await expect(reel).toHaveAttribute('aria-valuemax', '8');
  await expect(page.getByRole('checkbox', { name: 'Include end card' })).not.toBeChecked();
});
