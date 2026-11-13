import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { diaryExports } from '../../src/app/export';
import { groupEvents } from '../../src/core/events';
import { parseMegaDetector, toMegaDetectorJson } from '../../src/core/megadetectorJson';
import type { CameraTime } from '../../src/core/time';
import type { PhotoResult } from '../../src/core/types';
import type { StoredResult } from '../../src/storage/schema';

const deer = 'deer-uuid;mammalia;artiodactyla;cervidae;odocoileus;virginianus;white-tailed deer';
const wallClockMs = Date.UTC(2026, 10, 1, 2, 3, 4);

const time: CameraTime = {
  wallClockMs,
  wallClockHour: 2,
  timeSource: 'exif',
  offsetTimeOriginal: null,
  clockStatus: 'ok',
};

function input() {
  const path = 'card/DCIM/100MEDIA/a.jpg';
  const result: StoredResult = {
    key: `${path}|1|2`,
    time,
    output: {
      path,
      backend: 'wasm',
      ms: { decode: 0, preprocess: 0, detect: 0, classify: 0, ensemble: 0, thumbnail: 0, total: 0 },
      status: 'ok',
      width: 10,
      height: 10,
      thumbnail: new Blob(['preview']),
      detections: [
        {
          category: '1',
          label: 'animal',
          conf: 0.9,
          bbox: [0.1, 0.2, 0.3, 0.4],
          processed_classification: { class: deer, score: 0.88, source: 'classifier' },
        },
      ],
    },
  };
  const photo: PhotoResult = {
    path,
    time,
    detections: result.output.status === 'ok' ? result.output.detections : [],
  };
  return {
    results: [result],
    events: groupEvents([photo]),
    camtrap: {
      locations: { 'card/DCIM': { latitude: 0, longitude: 0 } },
      project: {
        title: 'Test project',
        samplingDesign: 'opportunistic' as const,
        individualAnimals: false,
      },
      contributors: [{ title: 'Test contributor' }],
    },
  };
}

test('names the CSV, SpeciesNet, MegaDetector and Camtrap DP downloads', () => {
  const files = diaryExports(input(), '2026-11-06T00:00:00.000Z');

  expect(files.csv.name).toBe('deerdiary.csv');
  expect(files.json.name).toBe('speciesnet.json');
  expect(files.megadetector.name).toBe('megadetector.json');
  expect(files.camtrapDp.map(({ name }) => name)).toEqual([
    'datapackage.json',
    'deployments.csv',
    'media.csv',
    'observations.csv',
  ]);
});

test('the CSV starts with a byte-order mark and the detection header', () => {
  const files = diaryExports(input(), '2026-11-06T00:00:00.000Z');

  expect(files.csv.text.startsWith('\uFEFFpath,camera,wall_clock')).toBe(true);
  expect(files.csv.text).toContain('card/DCIM,2026-11-01T02:03:04.000Z');
});

test('the JSON carries one prediction and the event used by a re-import', () => {
  const parsed = JSON.parse(diaryExports(input(), '2026-11-06T00:00:00.000Z').json.text) as {
    info: { format_version: string };
    predictions: unknown[];
    deerdiary: { events: { id: string; species: string[] }[] };
  };

  expect(parsed.info.format_version).toBe('20261015');
  expect(parsed.predictions).toHaveLength(1);
  expect(parsed.deerdiary.events).toEqual([
    {
      id: 'card/DCIM@1793498584000',
      camera: 'card/DCIM',
      photos: ['card/DCIM/100MEDIA/a.jpg'],
      species: [deer],
    },
  ]);
});

test('the datapackage names the three tables it ships beside it', () => {
  const files = diaryExports(input(), '2026-11-06T00:00:00.000Z');
  const datapackage = JSON.parse(files.camtrapDp[0]?.text ?? '') as {
    name: string;
    created: string;
    resources: { path: string }[];
  };

  expect(datapackage.name).toBe('deerdiary-camtrap-dp');
  expect(datapackage.created).toBe('2026-11-06T00:00:00.000Z');
  expect(datapackage.resources.map(({ path }) => path)).toEqual([
    'deployments.csv',
    'media.csv',
    'observations.csv',
  ]);
});

test('the MegaDetector file names the detector that ran and reads back as the same photo', () => {
  const files = diaryExports(
    { ...input(), detector: 'mdv6-apa-rtdetr-c-fp32' },
    '2026-11-06T00:00:00.000Z',
  );
  const written = JSON.parse(files.megadetector.text) as { info: { detector: string } };

  expect(written.info.detector).toBe('mdv6-apa-rtdetr-c-fp32');
  expect(parseMegaDetector(written)).toEqual({
    ok: true,
    value: {
      formatVersion: '1.6',
      images: [
        {
          file: 'card/DCIM/100MEDIA/a.jpg',
          detections: [
            {
              category: 'animal',
              conf: 0.9,
              bbox: [0.1, 0.2, 0.3, 0.4],
              classifications: [{ name: 'white-tailed deer', conf: 0.88 }],
            },
          ],
        },
      ],
    },
  });
});

// tools/eval/validate_exports.py checks the committed file with MegaDetector's own validator, so
// the writer must still produce the same content.
test('the writer reproduces the MegaDetector fixture the validator checks', async () => {
  const fixture = await readFile('tests/e2e/fixtures/export/megadetector.json', 'utf8');
  const fox = 'fox-uuid;mammalia;carnivora;canidae;vulpes;vulpes;red fox';
  const written = toMegaDetectorJson({
    detectionCompletionTime: '2026-11-01T02:03:04Z',
    images: [
      {
        file: 'card/DCIM/100MEDIA/a.jpg',
        detections: [
          {
            category: '1',
            conf: 0.9,
            bbox: [0.1, 0.2, 0.3, 0.4],
            raw_classifications: { classes: [deer, fox], scores: [0.88, 0.12] },
          },
        ],
      },
      { file: 'card/DCIM/100MEDIA/broken.jpg', failure: 'DECODE_FAILED', detections: [] },
    ],
  });

  expect(JSON.parse(written)).toEqual(JSON.parse(fixture));
});

test('every export carries the human replacement and preserves the machine prediction', () => {
  const data = input();
  const fox = 'fox-id;mammalia;carnivora;canidae;vulpes;vulpes;red fox';
  const key = `card/DCIM@1793498584000\u0000${deer}`;
  const files = diaryExports({ ...data, corrections: { [key]: fox } }, '2026-11-06T00:00:00.000Z');
  expect(files.csv.text).toContain('red fox');
  const json = JSON.parse(files.json.text);
  expect(json.predictions[0].detections[0].processed_classification.class).toBe(fox);
  expect(json.predictions[0].detections[0].machine_classification.class).toBe(deer);
  expect(json.deerdiary.events[0].species).toEqual([fox]);
  const md = JSON.parse(files.megadetector.text);
  const category = md.images[0].detections[0].classifications[0][0];
  expect(md.classification_categories[category]).toBe('red fox');
  expect(md.deerdiary.corrections).toEqual({ [key]: fox });
  expect(md.deerdiary.machine_predictions[0].detections[0].processed_classification.class).toBe(
    deer,
  );
  expect(files.camtrapDp.at(-1)?.text).toContain('vulpes vulpes');
  expect(
    data.results[0]?.output.status === 'ok' &&
      data.results[0].output.detections[0]?.processed_classification?.class,
  ).toBe(deer);
});

test('CSV primary labels use the correction and name machine provenance separately', async () => {
  const { buildCsvRows } = await import('../../src/app/export');
  const fox = 'fox-id;mammalia;carnivora;canidae;vulpes;vulpes;red fox';
  const rows = buildCsvRows({
    ...input(),
    corrections: { [`card/DCIM@1793498584000\u0000${deer}`]: fox },
  });
  expect(rows[0]?.common_name).toBe('red fox');
  expect(rows[0]?.scientific_name).toBe('vulpes vulpes');
  expect(rows[0]?.source).toBe('human');
});

test('missing Camtrap coordinates block only Camtrap DP, leaving the other downloads available', () => {
  const { camtrap: _metadata, ...data } = input();
  const files = diaryExports(data, '2026-11-06T00:00:00Z');
  expect(files.csv.text).toContain('card/DCIM');
  expect(JSON.parse(files.json.text).predictions).toHaveLength(1);
  expect(JSON.parse(files.megadetector.text).images).toHaveLength(1);
  expect(() => files.camtrapDp).toThrow(/latitude and longitude.*card\/DCIM/);
});
