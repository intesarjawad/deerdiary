import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, type Page } from '@playwright/test';
import type * as video from '../../src/files/video';
import { openApp } from '../fixtures/app';
import { browserModule } from '../fixtures/browser-module';
import { test } from '../fixtures/storage';

const run = promisify(execFile);

// The service worker answers from this cache, so a controlled page can import a module put there.
const SHELL_CACHE = 'deerdiary-shell-v1';
const CLIP_SECONDS = 5;
// A clip written at 5 fps, so sampling one frame per second must skip four frames in five.
const CLIP_FPS = 5;
const HEVC_CODECS = 'video/mp4; codecs="hvc1.1.6.L60.90"';

let directory = '';

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'deerdiary-video-'));
  const source = ['-f', 'lavfi', '-i', `testsrc2=size=160x120:rate=${CLIP_FPS}`];
  await run('ffmpeg', [
    ...['-v', 'error', ...source, '-t', String(CLIP_SECONDS)],
    ...['-c:v', 'mjpeg', '-q:v', '4', join(directory, 'clip.avi')],
  ]);
  await run('ffmpeg', [
    ...['-v', 'error', ...source, '-t', '2', '-pix_fmt', 'yuv420p'],
    ...['-c:v', 'libx265', '-tag:v', 'hvc1', '-x265-params', 'log-level=error'],
    join(directory, 'clip-hevc.mp4'),
  ]);
});

test.afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

type Extracted =
  | { status: 'ok'; variances: number[] }
  | { status: 'unsupported_codec'; codec: string }
  | { status: 'decode_failed' }
  | { status: 'threw'; message: string };

async function extract(page: Page, baseURL: string | undefined, name: string): Promise<Extracted> {
  if (!baseURL) throw new Error('Video tests require baseURL.');
  await openApp(page);
  const url = new URL('video-test/video.js', baseURL).href;
  const code = await browserModule('src/files/video.ts');
  const bytes = (await readFile(join(directory, name))).toString('base64');
  return page.evaluate(
    async ({ url, code, cacheName, bytes, name }) => {
      const cache = await caches.open(cacheName);
      await cache.put(url, new Response(code, { headers: { 'Content-Type': 'text/javascript' } }));
      const module: typeof video = await import(url);
      const file = new File([Uint8Array.from(atob(bytes), (char) => char.charCodeAt(0))], name);
      let result: Awaited<ReturnType<typeof module.extractVideoFrames>>;
      try {
        result = await module.extractVideoFrames(file);
      } catch (error) {
        return { status: 'threw' as const, message: String(error) };
      }
      if (result.status !== 'ok') return result;
      const variances = result.frames.map((frame) => {
        const canvas = new OffscreenCanvas(frame.width, frame.height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('No 2D canvas context.');
        context.drawImage(frame, 0, 0);
        const { data } = context.getImageData(0, 0, frame.width, frame.height);
        const luma: number[] = [];
        for (let i = 0; i < data.length; i += 4) luma.push(data[i] ?? 0);
        const mean = luma.reduce((sum, value) => sum + value, 0) / luma.length;
        frame.close();
        return luma.reduce((sum, value) => sum + (value - mean) ** 2, 0) / luma.length;
      });
      return { status: 'ok' as const, variances };
    },
    { url, code, cacheName: SHELL_CACHE, bytes, name },
  );
}

test('an MJPEG AVI yields one decoded frame per second', async ({ page, baseURL }) => {
  const result = await extract(page, baseURL, 'clip.avi');

  if (result.status !== 'ok') throw new Error(`Expected frames, got ${JSON.stringify(result)}`);
  expect(result.variances).toHaveLength(CLIP_SECONDS);
  for (const variance of result.variances) expect(variance).toBeGreaterThan(0);
});

test('an HEVC clip is reported by codec where this engine cannot decode it', async ({
  page,
  baseURL,
}) => {
  const result = await extract(page, baseURL, 'clip-hevc.mp4');
  const decodesHevc = await page.evaluate(
    (type) => document.createElement('video').canPlayType(type) !== '',
    HEVC_CODECS,
  );

  if (decodesHevc) expect(result.status).toBe('ok');
  else expect(result).toEqual({ status: 'unsupported_codec', codec: 'hevc' });
});
