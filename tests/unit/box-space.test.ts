import { describe, expect, test } from 'vitest';
import { thumbnailSize } from '../../src/core/crops';
import { decodeSorrel, decodeYolov5 } from '../../src/core/detections';
import { frameRank } from '../../src/core/events';
import { letterboxGeometry } from '../../src/core/letterbox';

// A 4:3 landscape frame and a portrait one; the box is normalized to the original image.
const frames = [
  { width: 1600, height: 1167 },
  { width: 900, height: 1600 },
];
const box = [0.61, 0.42, 0.25, 0.3] as const;

function toLetterboxPixels(
  geometry: ReturnType<typeof letterboxGeometry>,
  [x, y, w, h]: readonly [number, number, number, number],
) {
  const { srcW, srcH, scale, left, top } = geometry;
  return {
    x1: x * srcW * scale + left,
    y1: y * srcH * scale + top,
    x2: (x + w) * srcW * scale + left,
    y2: (y + h) * srcH * scale + top,
  };
}

describe.each(frames)('a $width x $height frame', ({ width, height }) => {
  test('a box in letterboxed pixels decodes back to its normalized box (fixed square)', () => {
    const geometry = letterboxGeometry(width, height, 960, 32, false);
    const { x1, y1, x2, y2 } = toLetterboxPixels(geometry, box);
    const rows = new Float32Array(300 * 6);
    rows.set([x1, y1, x2, y2, 0.9, 0]);
    const [detection] = decodeSorrel(rows, geometry);
    expect(detection?.bbox[0]).toBeCloseTo(box[0], 2);
    expect(detection?.bbox[1]).toBeCloseTo(box[1], 2);
    expect(detection?.bbox[2]).toBeCloseTo(box[2], 2);
    expect(detection?.bbox[3]).toBeCloseTo(box[3], 2);
  });

  test('a YOLOv5 box decodes back to its normalized box (minimum-stride padding)', () => {
    const geometry = letterboxGeometry(width, height, 1280, 64, true);
    const { x1, y1, x2, y2 } = toLetterboxPixels(
      {
        ...geometry,
        left: (geometry.width - width * geometry.scale) / 2,
        top: (geometry.height - height * geometry.scale) / 2,
      },
      box,
    );
    const [detection] = decodeYolov5(
      Float32Array.from([(x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1, 1, 1, 0, 0]),
      geometry,
    );
    expect(detection?.bbox[0]).toBeCloseTo(box[0], 2);
    expect(detection?.bbox[1]).toBeCloseTo(box[1], 2);
    expect(detection?.bbox[2]).toBeCloseTo(box[2], 2);
    expect(detection?.bbox[3]).toBeCloseTo(box[3], 2);
  });

  test('a preview keeps the frame aspect, so the same normalized box lands on the same content', () => {
    const preview = thumbnailSize(width, height, 256);
    expect(Math.max(preview.width, preview.height)).toBe(256);
    expect(preview.width / preview.height).toBeCloseTo(width / height, 1);
    expect(box[0] * preview.width).toBeCloseTo(box[0] * width * (preview.width / width), 6);
  });
});

test('a preview is never enlarged', () => {
  expect(thumbnailSize(200, 100, 256)).toEqual({ width: 200, height: 100 });
});

describe('the frame shown for an animal', () => {
  const detection = (bbox: [number, number, number, number], conf = 0.9, score = 0.9) =>
    ({ category: '1', conf, bbox, processed_classification: { class: 'a', score } }) as never;

  test('a whole animal beats a larger box cut off by the frame edge', () => {
    expect(frameRank(detection([0.3, 0.3, 0.2, 0.2]))).toBeGreaterThan(
      frameRank(detection([0, 0.16, 1, 0.84])),
    );
  });

  test('a corner sliver cannot win over a centred animal', () => {
    expect(frameRank(detection([0.4, 0.4, 0.1, 0.1], 0.8, 0.8))).toBeGreaterThan(
      frameRank(detection([0, 0.85, 0.31, 0.15], 0.91, 0.71)),
    );
  });

  test('among edge-cut boxes the surer and larger one still ranks first', () => {
    expect(frameRank(detection([0, 0, 0.5, 0.5], 0.9, 0.9))).toBeGreaterThan(
      frameRank(detection([0, 0, 0.1, 0.1], 0.9, 0.9)),
    );
  });
});

describe('portrait choice', () => {
  const rank = (bbox: readonly [number, number, number, number]) =>
    frameRank({ conf: 0.9, bbox, processed_classification: { score: 0.9 } } as never);

  test('a clear whole animal beats a fur close-up', () => {
    expect(rank([0.3, 0.3, 0.2, 0.2])).toBeGreaterThan(rank([0.05, 0.05, 0.9, 0.9]));
  });

  test('a centred animal beats the same one at the edge of the frame', () => {
    expect(rank([0.4, 0.4, 0.2, 0.2])).toBeGreaterThan(rank([0.7, 0.7, 0.2, 0.2]));
  });
});
