import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { thumbnailSize } from '../../src/core/crops';

/**
 * Rewrites `public/sample/thumbs/` from the sample photos without running any model: each preview
 * is the whole frame scaled to the same long edge the app stores, so the boxes in
 * `predictions.json` land on it. `npm run sample:predict` writes the same previews as a side
 * effect of a full run; this is the model-free path.
 */

const SAMPLE_DIR = 'public/sample';
const THUMBNAILS_DIR = `${SAMPLE_DIR}/thumbs`;
const LONG_EDGE = 256;
const JPEG_QUALITY = 0.8;

const photos = (await readdir(SAMPLE_DIR)).filter((name) => name.endsWith('.jpg')).toSorted();
await mkdir(THUMBNAILS_DIR, { recursive: true });

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const name of photos) {
    const bytes = Array.from(await readFile(join(SAMPLE_DIR, name)));
    const size = await page.evaluate(
      async ({ bytes: data }) => {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)]));
        const dimensions = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        return dimensions;
      },
      { bytes },
    );
    const target = thumbnailSize(size.width, size.height, LONG_EDGE);
    const encoded = await page.evaluate(
      async ({ bytes: data, width, height, quality }) => {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)]));
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Could not create a canvas.');
        context.imageSmoothingQuality = 'high';
        context.drawImage(bitmap, 0, 0, width, height);
        bitmap.close();
        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
        return Array.from(new Uint8Array(await blob.arrayBuffer()));
      },
      { bytes, ...target, quality: JPEG_QUALITY },
    );
    await writeFile(join(THUMBNAILS_DIR, name), Uint8Array.from(encoded));
  }
  console.log(`Wrote ${photos.length} previews in ${THUMBNAILS_DIR}/`);
} finally {
  await browser.close();
}
