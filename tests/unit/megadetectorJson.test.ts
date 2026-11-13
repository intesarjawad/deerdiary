import { expect, test } from 'vitest';
import {
  MEGADETECTOR_DETECTOR,
  MEGADETECTOR_FORMAT_VERSION,
  megaDetectorExportFromResults,
  parseMegaDetector,
  toMegaDetectorJson,
} from '../../src/core/megadetectorJson';
import type { StoredResult } from '../../src/storage/schema';

const deer = 'deer-uuid;mammalia;artiodactyla;cervidae;odocoileus;virginianus;white-tailed deer';
const fox = 'fox-uuid;mammalia;carnivora;canidae;vulpes;vulpes;red fox';

test('parses an image with a detection and a resolved classification', () => {
  const input = {
    info: { format_version: '1.6' },
    detection_categories: { '1': 'animal', '2': 'person', '3': 'vehicle' },
    classification_categories: { f1856211: 'deer' },
    images: [
      {
        file: 'DCIM/100MEDIA/a.jpg',
        detections: [
          {
            category: '1',
            conf: 0.87,
            bbox: [0.1, 0.2, 0.3, 0.4],
            classifications: [['f1856211', 0.75]],
          },
        ],
      },
    ],
  };

  expect(parseMegaDetector(input)).toEqual({
    ok: true,
    value: {
      formatVersion: '1.6',
      images: [
        {
          file: 'DCIM/100MEDIA/a.jpg',
          detections: [
            {
              category: 'animal',
              conf: 0.87,
              bbox: [0.1, 0.2, 0.3, 0.4],
              classifications: [{ name: 'deer', conf: 0.75 }],
            },
          ],
        },
      ],
    },
  });
});

test('accepts an image that failed with no detections', () => {
  const input = {
    info: { format_version: '1.6' },
    detection_categories: { '1': 'animal' },
    images: [{ file: 'broken.jpg', failure: 'corrupt image' }],
  };

  expect(parseMegaDetector(input)).toEqual({
    ok: true,
    value: {
      formatVersion: '1.6',
      images: [{ file: 'broken.jpg', failure: 'corrupt image', detections: [] }],
    },
  });
});

test('rejects a file without an info block', () => {
  expect(parseMegaDetector({ detection_categories: { '1': 'animal' }, images: [] })).toEqual({
    ok: false,
    field: 'info',
  });
});

test('names the first detection with a non-numeric confidence', () => {
  const input = {
    info: { format_version: '1.6' },
    detection_categories: { '1': 'animal' },
    images: [
      {
        file: 'a.jpg',
        detections: [{ category: '1', conf: '0.87', bbox: [0.1, 0.2, 0.3, 0.4] }],
      },
    ],
  };

  expect(parseMegaDetector(input)).toEqual({
    ok: false,
    field: 'images[0].detections[0].conf',
  });
});

test('names a box that does not have four numbers', () => {
  const input = {
    info: { format_version: '1.6' },
    detection_categories: { '1': 'animal' },
    images: [
      {
        file: 'a.jpg',
        detections: [{ category: '1', conf: 0.87, bbox: [0.1, 0.2, 0.3] }],
      },
    ],
  };

  expect(parseMegaDetector(input)).toEqual({
    ok: false,
    field: 'images[0].detections[0].bbox',
  });
});

test('names an unknown detection category id', () => {
  const input = {
    info: { format_version: '1.6' },
    detection_categories: { '1': 'animal' },
    images: [
      {
        file: 'a.jpg',
        detections: [{ category: '9', conf: 0.87, bbox: [0.1, 0.2, 0.3, 0.4] }],
      },
    ],
  };

  expect(parseMegaDetector(input)).toEqual({
    ok: false,
    field: 'images[0].detections[0].category',
  });
});

test('names an unknown classification category id', () => {
  const input = {
    info: { format_version: '1.6' },
    detection_categories: { '1': 'animal' },
    classification_categories: { deer: 'deer' },
    images: [
      {
        file: 'a.jpg',
        detections: [
          {
            category: '1',
            conf: 0.87,
            bbox: [0.1, 0.2, 0.3, 0.4],
            classifications: [['elk', 0.75]],
          },
        ],
      },
    ],
  };

  expect(parseMegaDetector(input)).toEqual({
    ok: false,
    field: 'images[0].detections[0].classifications[0][0]',
  });
});

test('writes the MegaDetector batch with numeric classification ids', () => {
  const written = JSON.parse(
    toMegaDetectorJson({
      images: [
        {
          file: 'card/DCIM/100MEDIA/a.jpg',
          detections: [
            {
              category: '1',
              conf: 0.9,
              bbox: [0.1, 0.2, 0.3, 0.4],
              raw_classifications: {
                classes: [deer, fox],
                scores: [0.8, 0.2],
              },
              processed_classification: { class: deer, score: 0.8 },
            },
          ],
        },
        { file: 'card/DCIM/broken.jpg', failure: 'DECODE_FAILED', detections: [] },
      ],
      detectionCompletionTime: '2026-11-01T02:03:04Z',
    }),
  );

  expect(written.info).toEqual({
    format_version: MEGADETECTOR_FORMAT_VERSION,
    detector: MEGADETECTOR_DETECTOR,
    detection_completion_time: '2026-11-01T02:03:04Z',
  });
  expect(written.detection_categories).toEqual({
    '1': 'animal',
    '2': 'person',
    '3': 'vehicle',
  });
  expect(written.classification_categories).toEqual({
    '1': 'white-tailed deer',
    '2': 'red fox',
  });
  expect(written.images[0].detections[0].classifications).toEqual([
    ['1', 0.8],
    ['2', 0.2],
  ]);
  expect(written.images[1]).toEqual({
    file: 'card/DCIM/broken.jpg',
    failure: 'DECODE_FAILED',
    detections: null,
  });
});

test('falls back to the processed class when a detection has no raw classes', () => {
  const written = JSON.parse(
    toMegaDetectorJson({
      images: [
        {
          file: 'a.jpg',
          detections: [
            {
              category: '1',
              conf: 0.9,
              bbox: [0.1, 0.2, 0.3, 0.4],
              processed_classification: { class: fox, score: 0.75 },
            },
          ],
        },
      ],
    }),
  );

  expect(written.classification_categories).toEqual({ '1': 'red fox' });
  expect(written.images[0].detections[0].classifications).toEqual([['1', 0.75]]);
});

test('parses the written MegaDetector batch back to names', () => {
  const written = toMegaDetectorJson({
    images: [
      {
        file: 'a.jpg',
        detections: [
          {
            category: '1',
            conf: 0.9,
            bbox: [0.1, 0.2, 0.3, 0.4],
            raw_classifications: { classes: [deer, fox], scores: [0.8, 0.2] },
          },
        ],
      },
      { file: 'broken.jpg', failure: 'DECODE_FAILED', detections: [] },
    ],
  });

  expect(parseMegaDetector(JSON.parse(written))).toEqual({
    ok: true,
    value: {
      formatVersion: MEGADETECTOR_FORMAT_VERSION,
      images: [
        {
          file: 'a.jpg',
          detections: [
            {
              category: 'animal',
              conf: 0.9,
              bbox: [0.1, 0.2, 0.3, 0.4],
              classifications: [
                { name: 'white-tailed deer', conf: 0.8 },
                { name: 'red fox', conf: 0.2 },
              ],
            },
          ],
        },
        { file: 'broken.jpg', failure: 'DECODE_FAILED', detections: [] },
      ],
    },
  });
});

test('maps stored results to a batch that keeps failed photos in place', () => {
  const time = {
    wallClockMs: Date.UTC(2026, 10, 1, 2, 3, 4),
    wallClockHour: 2,
    timeSource: 'exif' as const,
    offsetTimeOriginal: null,
    clockStatus: 'ok' as const,
  };
  const ms = {
    decode: 0,
    preprocess: 0,
    detect: 0,
    classify: 0,
    ensemble: 0,
    thumbnail: 0,
    total: 0,
  };
  const results: StoredResult[] = [
    {
      key: 'a',
      time,
      output: {
        path: 'card/a.jpg',
        backend: 'wasm',
        ms,
        status: 'ok',
        width: 640,
        height: 480,
        thumbnail: new Blob(['preview']),
        detections: [
          {
            category: '1',
            label: 'animal',
            conf: 0.9,
            bbox: [0.1, 0.2, 0.3, 0.4],
            processed_classification: { class: deer, score: 0.8, source: 'classifier' },
          },
        ],
      },
    },
    {
      key: 'b',
      time,
      output: { path: 'card/b.jpg', backend: 'wasm', ms, status: 'decode_failed' },
    },
  ];

  const written = JSON.parse(
    toMegaDetectorJson(megaDetectorExportFromResults(results, '2026-11-01T02:03:04Z')),
  );

  expect(written.info.detection_completion_time).toBe('2026-11-01T02:03:04Z');
  expect(written.classification_categories).toEqual({ '1': 'white-tailed deer' });
  expect(written.images).toEqual([
    {
      file: 'card/a.jpg',
      detections: [
        { category: '1', conf: 0.9, bbox: [0.1, 0.2, 0.3, 0.4], classifications: [['1', 0.8]] },
      ],
    },
    { file: 'card/b.jpg', failure: 'DECODE_FAILED', detections: null },
  ]);
});
