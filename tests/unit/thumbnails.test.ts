import { expect, test } from 'vitest';
import { createThumbnailURLs, thumbnailBlobs } from '../../src/app/thumbnails';
import type { CameraTime } from '../../src/core/time';
import type { StoredResult } from '../../src/storage/schema';

const time: CameraTime = {
  wallClockMs: Date.UTC(2026, 10, 1),
  wallClockHour: 0,
  timeSource: 'exif',
  offsetTimeOriginal: null,
  clockStatus: 'ok',
};

function processed(path: string, thumbnail: Blob): StoredResult {
  return {
    key: `${path}|1|2`,
    time,
    output: {
      path,
      backend: 'wasm',
      ms: { decode: 0, preprocess: 0, detect: 0, classify: 0, ensemble: 0, thumbnail: 0, total: 0 },
      status: 'ok',
      width: 10,
      height: 10,
      thumbnail,
      detections: [],
    },
  };
}

function failed(path: string): StoredResult {
  return {
    key: `${path}|1|2`,
    time,
    output: {
      path,
      backend: 'wasm',
      ms: { decode: 0, preprocess: 0, detect: 0, classify: 0, ensemble: 0, thumbnail: 0, total: 0 },
      status: 'decode_failed',
    },
  };
}

test('keeps one preview per processed photo and none for a failed decode', () => {
  const first = new Blob(['first']);
  const second = new Blob(['second']);

  const blobs = thumbnailBlobs([
    processed('card/a.jpg', first),
    failed('card/b.jpg'),
    processed('card/c.jpg', second),
  ]);

  expect(Array.from(blobs)).toEqual([
    ['card/a.jpg', first],
    ['card/c.jpg', second],
  ]);
});

test('creates each URL once and revokes it when the results are replaced', () => {
  const created: Blob[] = [];
  const revoked: string[] = [];
  const urls = createThumbnailURLs(
    (blob) => {
      created.push(blob);
      return `blob:${created.length}`;
    },
    (url) => revoked.push(url),
  );

  const first = new Blob(['first']);
  urls.update([processed('card/a.jpg', first)]);

  expect(urls.url('card/a.jpg')).toBe('blob:1');
  expect(urls.url('card/a.jpg')).toBe('blob:1');
  expect(urls.url('card/missing.jpg')).toBeUndefined();
  expect(created).toEqual([first]);

  urls.update([processed('card/c.jpg', new Blob(['second']))]);
  expect(revoked).toEqual(['blob:1']);
  expect(urls.url('card/a.jpg')).toBeUndefined();
  expect(urls.url('card/c.jpg')).toBe('blob:2');
});

test('omits empty backup previews without creating broken image URLs', () => {
  const urls = createThumbnailURLs(() => {
    throw new Error('An empty preview must not get a URL');
  });
  const results = [processed('card/a.jpg', new Blob())];
  expect(thumbnailBlobs(results).size).toBe(0);
  urls.update(results);
  expect(urls.url('card/a.jpg')).toBeUndefined();
});
