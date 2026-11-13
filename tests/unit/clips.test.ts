import { expect, test } from 'vitest';
import { mergeClipFrames, skippedClip, unsupportedClipsNote } from '../../src/app/clips';
import type { StoredResult } from '../../src/storage/schema';
import type { ClassifiedDetection, PhotoResult } from '../../src/workers/photo';
import { time } from './fixtures/pipeline';

const deer = 'deer;mammalia;artiodactyla;cervidae;odocoileus;virginianus;white-tailed deer';
const fox = 'fox;mammalia;carnivora;canidae;vulpes;vulpes;red fox';
const ms = {
  decode: 1,
  preprocess: 2,
  detect: 3,
  classify: 4,
  ensemble: 5,
  thumbnail: 6,
  total: 21,
};

function box(label: string, conf: number): ClassifiedDetection {
  return {
    category: '1',
    label: 'animal',
    conf,
    bbox: [0, 0, 0.5, 0.5],
    processed_classification: { class: label, score: 0.9, source: 'classifier' },
  };
}

function frame(name: string, detections: ClassifiedDetection[]): PhotoResult {
  return {
    path: 'cam/clip.mp4',
    backend: 'wasm',
    ms,
    status: 'ok',
    width: 64,
    height: 48,
    thumbnail: new Blob([name]),
    detections: detections.toSorted((a, b) => b.conf - a.conf),
  };
}

function labels(result: PhotoResult): string[] {
  return result.status === 'ok'
    ? result.detections.map(
        (detection) => `${detection.processed_classification?.class}@${detection.conf}`,
      )
    : [];
}

test('keeps, per species, the frame with the most boxes above the MaxN confidence', () => {
  const merged = mergeClipFrames('cam/clip.mp4', [
    frame('first', [box(deer, 0.9), box(fox, 0.5), box(fox, 0.4)]),
    // Three deer boxes, but one is below the MaxN confidence, so this frame counts two.
    frame('second', [box(deer, 0.8), box(deer, 0.7), box(deer, 0.1)]),
    frame('third', [box(fox, 0.6)]),
  ]);

  expect(merged.status).toBe('ok');
  expect(labels(merged)).toEqual([
    `${deer}@0.8`,
    `${deer}@0.7`,
    `${fox}@0.5`,
    `${fox}@0.4`,
    `${deer}@0.1`,
  ]);
});

test('takes the preview from the frame with the most confident box and sums stage times', async () => {
  const merged = mergeClipFrames('cam/clip.mp4', [
    frame('first', [box(deer, 0.6)]),
    frame('second', [box(deer, 0.95)]),
    frame('third', []),
  ]);

  if (merged.status !== 'ok') throw new Error('Expected a merged clip');
  expect(await merged.thumbnail.text()).toBe('second');
  expect(merged.ms).toEqual({
    decode: 3,
    preprocess: 6,
    detect: 9,
    classify: 12,
    ensemble: 15,
    thumbnail: 18,
    total: 63,
  });
  expect(merged).toMatchObject({ path: 'cam/clip.mp4', width: 64, height: 48 });
});

test('a clip with an unreadable frame keeps the frames that decoded', () => {
  const merged = mergeClipFrames('cam/clip.mp4', [
    { path: 'cam/clip.mp4', backend: 'wasm', ms, status: 'decode_failed' },
    frame('second', [box(fox, 0.7)]),
  ]);

  expect(labels(merged)).toEqual([`${fox}@0.7`]);
});

test('a clip with no readable frame is a decode failure', () => {
  expect(
    mergeClipFrames('cam/clip.mp4', [
      { path: 'cam/clip.mp4', backend: 'webgpu', ms, status: 'decode_failed' },
    ]),
  ).toEqual({ path: 'cam/clip.mp4', backend: 'webgpu', ms, status: 'decode_failed' });
});

function stored(path: string, codec: string): StoredResult {
  return {
    key: path,
    time,
    output: skippedClip(path, 'wasm', { status: 'unsupported_codec', codec }),
  };
}

test('says nothing when every clip decoded', () => {
  expect(unsupportedClipsNote([])).toBeNull();
});

test('names the codec of one skipped clip and the conversion command', () => {
  expect(unsupportedClipsNote([stored('cam/a.mp4', 'hevc')])).toBe(
    '1 video could not be decoded in this browser (codec: HEVC) and was skipped. Convert it to H.264 MP4, for example with "ffmpeg -i input.avi -c:v libx264 output.mp4", then drop the folder again.',
  );
});

test('lists each distinct codec once, including AVI FourCCs and unrecognised streams', () => {
  const note = unsupportedClipsNote([
    stored('cam/a.mp4', 'hevc'),
    stored('cam/b.mp4', 'hevc'),
    stored('cam/c.avi', 'XVID'),
    stored('cam/d.avi', 'H26\0'),
    stored('cam/e.mov', 'unknown'),
  ]);

  expect(note).toMatch(
    /^5 videos could not be decoded in this browser \(codec: H26, HEVC, XVID, unrecognised\) and were skipped\. Convert them/,
  );
});
