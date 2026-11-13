import { gunzipSync } from 'node:zlib';
import fc from 'fast-check';
import { expect, test } from 'vitest';
import manifest from '../../models/manifest.json';
import { defaultDetectorFile } from '../../src/app/models';
import { classifierCrop, cropBox } from '../../src/core/crops';
import { decodeRtdetr, decodeSorrel, decodeYolov5 } from '../../src/core/detections';
import { letterboxGeometry, letterboxInput, stretchGeometry } from '../../src/core/letterbox';
import {
  intersectionOverSmaller,
  intersectionOverUnion,
  nonMaxSuppression,
} from '../../src/core/nms';
import { resizeBilinear, resizeBilinearPil, toUint8LikeTorchvision } from '../../src/core/resize';
import type { Detection } from '../../src/core/types';
import golden from '../golden/resize_torchvision.json';

const unpack = (encoded: string) => {
  const bytes = new Uint8Array(gunzipSync(Buffer.from(encoded, 'base64')));
  for (let i = 3; i < bytes.length; i++) bytes[i] = ((bytes[i] ?? 0) + (bytes[i - 3] ?? 0)) % 256;
  return bytes;
};

for (const image of golden.images) {
  test(`${image.name}: five full-resolution crops match torchvision`, () => {
    const rgb = unpack(image.rgb);
    for (const crop of image.crops) {
      const [x, y, w, h] = crop.bbox;
      if (x === undefined || y === undefined || w === undefined || h === undefined)
        throw new Error('Invalid golden box');
      const actual = classifierCrop(rgb, image.width, image.height, [x, y, w, h]);
      const expected = unpack(crop.rgb);
      expect(actual.length).toBe(expected.length);
      let exact = 0;
      let maxError = 0;
      for (const [index, value] of actual.entries()) {
        const error = Math.abs(value - (expected[index] ?? -1));
        if (error === 0) exact++;
        maxError = Math.max(error, maxError);
      }
      expect(maxError).toBeLessThanOrEqual(1);
      expect(exact / expected.length).toBeGreaterThanOrEqual(0.999);
    }
  });
  test(`${image.name}: 640 stretch matches every PIL byte`, () => {
    const actual = resizeBilinearPil(unpack(image.rgb), image.width, image.height, 640, 640);
    expect(Buffer.from(actual).equals(Buffer.from(unpack(image.pil640)))).toBe(true);
  });
}

test('fixed square, stride-aligned and stretched geometries', () => {
  expect(letterboxGeometry(4000, 3000, 960, 32, false)).toMatchObject({
    scale: 0.24,
    resizedWidth: 960,
    resizedHeight: 720,
    width: 960,
    height: 960,
    top: 120,
    bottom: 120,
  });
  expect(letterboxGeometry(4000, 3000, 1280, 64, true)).toMatchObject({
    scale: 0.32,
    width: 1280,
    height: 960,
    top: 0,
    bottom: 0,
  });
  expect(letterboxGeometry(3000, 4000, 1280, 64, true)).toMatchObject({
    width: 960,
    height: 1280,
    left: 0,
  });
  expect(letterboxGeometry(11, 7, 10, 4, false)).toMatchObject({
    resizedHeight: 6,
    top: 2,
    bottom: 2,
  });
  expect(stretchGeometry(4000, 3000)).toMatchObject({
    width: 640,
    height: 640,
    scaleX: 0.16,
    scaleY: 640 / 3000,
  });
  expect(() => letterboxGeometry(0, 10, 960, 32, false)).toThrow();
});

test('crop truncates, ignores alpha and pads outside the original image', () => {
  const pixels = new Uint8Array([255, 10, 20, 0, 100, 40, 60, 255]);
  expect([...cropBox(pixels, 2, 1, [-0.6, 0, 1.5, 1]).data]).toEqual([
    0, 0, 0, 255, 10, 20, 100, 40, 60,
  ]);
  expect(toUint8LikeTorchvision(1)).toBe(255);
  expect(toUint8LikeTorchvision(0.5)).toBe(127);
  expect(() => cropBox(pixels, 2, 1, [0, 0, 0.1, 1])).toThrow();
});

test('resize preserves constant RGB/RGBA images and identity dimensions', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 15 }),
      fc.integer({ min: 1, max: 15 }),
      fc.integer({ min: 0, max: 255 }),
      (width, height, value) => {
        const rgb = new Uint8Array(width * height * 3).fill(value);
        expect(
          [
            ...Uint8Array.from(resizeBilinear(rgb, width, height, 9, 7), toUint8LikeTorchvision),
          ].every((v) => v === value),
        ).toBe(true);
        expect([...resizeBilinearPil(rgb, width, height, 9, 7)].every((v) => v === value)).toBe(
          true,
        );
        expect(
          Uint8Array.from(
            resizeBilinear(rgb, width, height, width, height),
            toUint8LikeTorchvision,
          ),
        ).toEqual(rgb);
      },
    ),
    { seed: 20261104 },
  );
  expect([...resizeBilinearPil(new Uint8Array([10, 20, 30, 0]), 1, 1, 1, 1)]).toEqual([10, 20, 30]);
});

test('NMS is class-aware, confidence-sorted, thresholded and limited to 300', () => {
  const animal: Detection = { category: '1', conf: 0.8, bbox: [0, 0, 0.5, 0.5] };
  const human: Detection = { ...animal, category: '2', conf: 0.9 };
  expect(
    nonMaxSuppression([animal, human, { ...animal, conf: 0.7 }, { ...animal, conf: 0.01 }]),
  ).toEqual([human, animal]);
  expect(
    nonMaxSuppression(
      Array.from({ length: 400 }, (_, i) => ({ ...animal, bbox: [i, 0, 0.5, 0.5] })),
    ),
  ).toHaveLength(300);
  fc.assert(
    fc.property(fc.double({ min: 0.001, max: 1, noNaN: true }), (size) => {
      const a: Detection['bbox'] = [0, 0, size, size];
      const b: Detection['bbox'] = [0.1, 0.1, size, size];
      expect(intersectionOverUnion(a, b)).toBe(intersectionOverUnion(b, a));
      expect(intersectionOverUnion(a, a)).toBeCloseTo(1);
      expect(intersectionOverSmaller(a, [0, 0, size / 2, size / 2])).toBeCloseTo(1);
      expect(intersectionOverSmaller(a, b)).toBe(intersectionOverSmaller(b, a));
    }),
    { seed: 20261104 },
  );
});

test('RT-DETR uses original width/height, preserves top-k duplicate boxes and classes', () => {
  const labels = new BigInt64Array(300);
  labels[1] = 1n;
  const boxes = new Float32Array(1200);
  boxes.set([10, 20, 50, 60, 10, 20, 50, 60]);
  const scores = new Float32Array(300);
  scores.set([0.8, 0.9]);
  const result = decodeRtdetr(labels, boxes, scores, 100, 200);
  expect(result).toHaveLength(2);
  expect(result[0]).toMatchObject({ category: '2', bbox: [0.1, 0.1, 0.4, 0.2] });
  labels[0] = 3n;
  expect(() => decodeRtdetr(labels, boxes, scores, 100, 200)).toThrow('class');
  expect(() => decodeRtdetr(labels, boxes.subarray(4), scores, 100, 200)).toThrow();
});

test('sorrel undoes fixed padding; YOLO multiplies objectness, suppresses, then rounds', () => {
  const rows = new Float32Array(1800);
  rows.set([240, 300, 720, 660, 0.8, 2]);
  expect(decodeSorrel(rows, letterboxGeometry(4000, 3000, 960, 32, false))[0]).toMatchObject({
    category: '3',
    bbox: [0.25, 0.25, 0.5, 0.5],
  });
  const yolo = new Float32Array([
    640, 480, 640, 480, 0.8, 0.5, 0.2, 0.1, 640, 480, 640, 480, 0.6, 0.5, 0.2, 0.1,
  ]);
  const result = decodeYolov5(yolo, letterboxGeometry(4000, 3000, 1280, 64, true));
  expect(result).toHaveLength(1);
  expect(result[0]?.conf).toBeCloseTo(0.4);
  expect(result[0]?.bbox).toEqual([0.25, 0.25, 0.5, 0.5]);
});

test('production default is fp32 and cannot fall back to the published sorrel candidate', () => {
  expect(manifest.default_detector).toBe('mdv6-apa-rtdetr-c-fp32');
  expect(() => defaultDetectorFile()).toThrow('pending publication');
});

test('letterbox input pads with 114, resizes like OpenCV and writes RGB planes', () => {
  // Two pixels upscaled to four columns blend at quarter steps; the row is centred between pads.
  const pixels = new Uint8Array([0, 200, 10, 200, 0, 10]);
  const input = letterboxInput(pixels, letterboxGeometry(2, 1, 4, 2, false));
  const pad = 114 / 255;
  const plane = 16;
  const rows = (channel: number) =>
    Array.from({ length: 4 }, (_, y) =>
      Array.from({ length: 4 }, (_, x) =>
        Math.round((input[channel * plane + y * 4 + x] ?? 0) * 255),
      ),
    );
  expect(rows(0)).toEqual([
    [114, 114, 114, 114],
    [0, 50, 150, 200],
    [0, 50, 150, 200],
    [114, 114, 114, 114],
  ]);
  expect(rows(1)[1]).toEqual([200, 150, 50, 0]);
  expect(rows(2)[2]).toEqual([10, 10, 10, 10]);
  expect(input[0]).toBeCloseTo(pad);
  expect(input).toHaveLength(3 * plane);
});
