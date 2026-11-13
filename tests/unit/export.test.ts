import { expect, test } from 'vitest';
import { buildCsvRows, eventId, exportCsv, exportJson } from '../../src/app/export';
import { parseImport } from '../../src/app/import';
import { groupEvents } from '../../src/core/events';
import type { CameraTime } from '../../src/core/time';
import type { PhotoResult } from '../../src/core/types';
import type { StoredResult } from '../../src/storage/schema';
import type {
  ClassifiedDetection,
  PhotoResult as WorkerPhotoResult,
} from '../../src/workers/photo';

const deer = 'deer-uuid;mammalia;artiodactyla;cervidae;odocoileus;virginianus;white-tailed deer';
const fox = 'fox-uuid;mammalia;carnivora;canidae;vulpes;vulpes;red fox';
const wallClockMs = Date.UTC(2026, 10, 1, 2, 3, 4);

const time: CameraTime = {
  wallClockMs,
  wallClockHour: 2,
  timeSource: 'exif',
  offsetTimeOriginal: null,
  clockStatus: 'ok',
};

const raw = {
  classes: [
    deer,
    fox,
    'blank-uuid;;;;;;blank',
    'animal-uuid;;;;;;animal',
    'human-uuid;mammalia;primates;hominidae;homo;sapiens;human',
    'vehicle-uuid;;;;;;vehicle',
  ],
  scores: [0.7, 0.1, 0.08, 0.06, 0.04, 0.02],
};

const detection: ClassifiedDetection = {
  category: '1',
  label: 'animal',
  conf: 0.9,
  bbox: [0.1, 0.2, 0.3, 0.4],
  raw_classifications: raw,
  processed_classification: { class: deer, score: 0.88, source: 'classifier' },
};

function workerOutput(path: string): WorkerPhotoResult {
  return {
    path,
    backend: 'wasm',
    ms: { decode: 0, preprocess: 0, detect: 0, classify: 0, ensemble: 0, thumbnail: 0, total: 0 },
    status: 'ok',
    width: 100,
    height: 80,
    thumbnail: new Blob(['preview']),
    detections: [detection],
  };
}

function input(path = 'card/DCIM/100MEDIA/a,b"c.jpg') {
  const output = workerOutput(path);
  if (output.status !== 'ok') throw new Error('Expected a classified photo');
  const stored: StoredResult = { key: `${path}|1|2`, time, output };
  const photo: PhotoResult = {
    path,
    time,
    detections: output.detections,
  };
  const events = groupEvents([photo]);
  return {
    results: [stored],
    events,
    corrections: { [`card/DCIM@1793498584000\u0000${deer}`]: 'Deer' },
  };
}

test('builds one row per detection with the burst and correction columns', () => {
  const rows = buildCsvRows(input());
  const path = 'card/DCIM/100MEDIA/a,b"c.jpg';

  expect(rows).toEqual([
    {
      path,
      camera: 'card/DCIM',
      wall_clock: '2026-11-01T02:03:04.000Z',
      time_source: 'exif',
      event_id: 'card/DCIM@1793498584000',
      independent: true,
      detection_index: 0,
      detector_label: 'animal',
      detector_conf: 0.9,
      bbox_x: 0.1,
      bbox_y: 0.2,
      bbox_w: 0.3,
      bbox_h: 0.4,
      label_uuid: 'Deer',
      common_name: 'Deer',
      scientific_name: null,
      score: 1,
      source: 'human',
      corrected_common_name: 'Deer',
      machine_label: deer,
      machine_score: 0.88,
      machine_source: 'classifier',
    },
  ]);
  const [event] = input().events;
  if (!event) throw new Error('Expected one event');
  expect(eventId(event)).toBe('card/DCIM@1793498584000');
});

test('writes the CSV with a BOM and quotes commas, quotes and newlines', () => {
  const [row] = buildCsvRows(input('card/DCIM/a\nb.jpg'));
  if (!row) throw new Error('Expected one row');
  const csv = exportCsv({ ...input('card/DCIM/a\nb.jpg'), corrections: {} });

  expect(csv.startsWith('\uFEFFpath,camera,wall_clock')).toBe(true);
  expect(csv).toContain('"card/DCIM/a\nb.jpg"');
});

test('exports JSON that imports again with five raw classes per detection', () => {
  const exported = exportJson(input());
  const written = JSON.parse(exported);
  const imported = parseImport(exported);

  expect(written.predictions[0].detections[0].raw_classifications.classes).toEqual([
    deer,
    fox,
    'blank-uuid;;;;;;blank',
    'animal-uuid;;;;;;animal',
    'human-uuid;mammalia;primates;hominidae;homo;sapiens;human',
  ]);
  expect(imported).toEqual({
    ok: true,
    value: {
      format: 'speciesnet',
      photos: [
        {
          path: 'card/DCIM/100MEDIA/a,b"c.jpg',
          detections: [
            {
              category: '1',
              label: 'animal',
              conf: 0.9,
              bbox: [0.1, 0.2, 0.3, 0.4],
              raw_classifications: {
                classes: [
                  deer,
                  fox,
                  'blank-uuid;;;;;;blank',
                  'animal-uuid;;;;;;animal',
                  'human-uuid;mammalia;primates;hominidae;homo;sapiens;human',
                ],
                scores: [0.7, 0.1, 0.08, 0.06, 0.04],
              },
              processed_classification: { class: deer, score: 0.88, source: 'classifier' },
            },
          ],
        },
      ],
      events: [
        {
          id: 'card/DCIM@1793498584000',
          camera: 'card/DCIM',
          photos: ['card/DCIM/100MEDIA/a,b"c.jpg'],
          species: ['Deer'],
        },
      ],
      corrections: { [`card/DCIM@1793498584000\u0000${deer}`]: 'Deer' },
      independenceIntervalMin: 30,
    },
  });
});

test('keeps a decode failure in the JSON without writing a CSV row', () => {
  const failed: WorkerPhotoResult = {
    path: 'card/DCIM/broken.jpg',
    backend: 'wasm',
    ms: { decode: 0, preprocess: 0, detect: 0, classify: 0, ensemble: 0, thumbnail: 0, total: 0 },
    status: 'decode_failed',
  };
  const stored: StoredResult = { key: 'broken', time, output: failed };
  const written = JSON.parse(exportJson({ results: [stored], events: [] }));

  expect(written.predictions[0]).toEqual({
    filepath: 'card/DCIM/broken.jpg',
    failures: ['DECODE_FAILED'],
    detections: [],
  });
  expect(buildCsvRows({ results: [stored], events: [] })).toEqual([]);
});
