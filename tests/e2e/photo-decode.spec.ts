import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { SHELL_CACHE_NAME } from '../../src/sw';
import type * as photo from '../../src/workers/photo';
import { openApp } from '../fixtures/app';
import { browserModule } from '../fixtures/browser-module';

const colors = [
  [137, 163, 197],
  [242, 206, 217],
  [253, 204, 197],
  [131, 101, 71],
  [117, 112, 107],
  [0, 0, 0],
];
const orientations = [
  { tiles: [0, 1, 2, 3, 4, 5], columns: 3 },
  { tiles: [2, 1, 0, 5, 4, 3], columns: 3 },
  { tiles: [5, 4, 3, 2, 1, 0], columns: 3 },
  { tiles: [3, 4, 5, 0, 1, 2], columns: 3 },
  { tiles: [0, 3, 1, 4, 2, 5], columns: 2 },
  { tiles: [3, 0, 4, 1, 5, 2], columns: 2 },
  { tiles: [5, 2, 4, 1, 3, 0], columns: 2 },
  { tiles: [2, 5, 1, 4, 0, 3], columns: 2 },
];

test('CMYK photo pixels match PIL RGB conversion with every EXIF orientation', async ({
  page,
  baseURL,
}) => {
  await openApp(page);
  const url = new URL('photo-test/photo.js', baseURL).href;
  const code = await browserModule('src/workers/photo.ts');
  const bytes = (await readFile('tests/fixtures/cmyk.jpg')).toString('base64');
  for (const [index, expected] of orientations.entries()) {
    const decoded = await page.evaluate(
      async ({ url, code, bytes, cacheName, orientation }) => {
        const cache = await caches.open(cacheName);
        await cache.put(
          url,
          new Response(code, { headers: { 'Content-Type': 'text/javascript' } }),
        );
        const { PhotoProcessor }: typeof photo = await import(url);
        const jpeg = Uint8Array.from(atob(bytes), (char) => char.charCodeAt(0));
        const exif = new Uint8Array([
          0xff,
          0xe1,
          0,
          34,
          69,
          120,
          105,
          102,
          0,
          0,
          73,
          73,
          42,
          0,
          8,
          0,
          0,
          0,
          1,
          0,
          18,
          1,
          3,
          0,
          1,
          0,
          0,
          0,
          orientation,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
        ]);
        const pixels: number[][] = [];
        const processor = new PhotoProcessor(
          {
            backend: 'wasm',
            detect: async () => [],
            detectPixels: async (rgba) => {
              pixels.push(Array.from(rgba));
              return [];
            },
            classify: async () => new Float32Array(),
          },
          [],
          { taxonomyMap: {}, geofenceMap: {} },
        );
        const file = new File([jpeg.slice(0, 2), exif, jpeg.slice(2)], 'cmyk.jpg', {
          type: 'image/jpeg',
        });
        return { result: await processor.process({ file, settings: {} }), pixels: pixels[0] };
      },
      { url, code, bytes, cacheName: SHELL_CACHE_NAME, orientation: index + 1 },
    );
    expect(decoded.result.status).toBe('ok');
    if (decoded.result.status !== 'ok' || !decoded.pixels) throw new Error('Photo decode failed');
    const { width, height } = decoded.result;
    expect([width, height]).toEqual([expected.columns * 8, (6 / expected.columns) * 8]);
    let maximumError = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const tile = expected.tiles[Math.floor(y / 8) * expected.columns + Math.floor(x / 8)];
        const rgb = colors[tile ?? -1];
        if (!rgb) throw new Error('Missing reference tile');
        for (const [channel, value] of rgb.entries())
          maximumError = Math.max(
            maximumError,
            Math.abs((decoded.pixels[(y * width + x) * 4 + channel] ?? -1) - value),
          );
      }
    }
    expect(maximumError, `EXIF orientation ${index + 1}`).toBeLessThanOrEqual(1);
  }
});
