import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { CAMTRAP_DP_PROFILE_URL, toCamtrapDp } from '../../src/core/camtrapDp';
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
const location = {
  latitude: 52.70442,
  longitude: 23.84995,
  locationID: 'loc1',
  locationName: 'Białowieża MRI 01',
  coordinateUncertainty: 100,
};

const DEPLOYMENT_COLUMNS = [
  'deploymentID',
  'locationID',
  'locationName',
  'latitude',
  'longitude',
  'coordinateUncertainty',
  'deploymentStart',
  'deploymentEnd',
  'setupBy',
  'cameraID',
  'cameraModel',
  'cameraDelay',
  'cameraHeight',
  'cameraDepth',
  'cameraTilt',
  'cameraHeading',
  'detectionDistance',
  'timestampIssues',
  'baitUse',
  'featureType',
  'habitat',
  'deploymentGroups',
  'deploymentTags',
  'deploymentComments',
] as const;

const MEDIA_COLUMNS = [
  'mediaID',
  'deploymentID',
  'captureMethod',
  'timestamp',
  'filePath',
  'filePublic',
  'fileName',
  'fileMediatype',
  'exifData',
  'favorite',
  'mediaComments',
] as const;

const OBSERVATION_COLUMNS = [
  'observationID',
  'deploymentID',
  'mediaID',
  'eventID',
  'eventStart',
  'eventEnd',
  'observationLevel',
  'observationType',
  'cameraSetupType',
  'scientificName',
  'count',
  'lifeStage',
  'sex',
  'behavior',
  'individualID',
  'individualPositionRadius',
  'individualPositionAngle',
  'individualSpeed',
  'bboxX',
  'bboxY',
  'bboxWidth',
  'bboxHeight',
  'classificationMethod',
  'classifiedBy',
  'classificationTimestamp',
  'classificationProbability',
  'observationTags',
  'observationComments',
] as const;

function row(
  columns: readonly string[],
  values: Readonly<Record<string, string | number | boolean>>,
): string {
  return columns.map((column) => String(values[column] ?? '')).join(',');
}

function cameraTime(offsetMs: number): CameraTime {
  return {
    wallClockMs: wallClockMs + offsetMs,
    wallClockHour: 2,
    timeSource: 'exif',
    offsetTimeOriginal: null,
    clockStatus: 'ok',
  };
}

function detection(
  label: string,
  conf: number,
  score: number,
  bbox: readonly [number, number, number, number],
): ClassifiedDetection {
  return {
    category: '1',
    label: 'animal',
    conf,
    bbox,
    processed_classification: { class: label, score, source: 'classifier' },
  };
}

function makePhoto(path: string, offsetMs: number, detections: ClassifiedDetection[]) {
  const time = cameraTime(offsetMs);
  const photo: PhotoResult = { path, time, detections };
  const output: WorkerPhotoResult = {
    path,
    backend: 'wasm',
    ms: { decode: 0, preprocess: 0, detect: 0, classify: 0, ensemble: 0, thumbnail: 0, total: 0 },
    status: 'ok',
    width: 100,
    height: 80,
    thumbnail: new Blob(['preview']),
    detections,
  };
  const stored: StoredResult = { key: path, time, output };
  return { photo, stored };
}

function input() {
  const first = makePhoto('card/DCIM/100MEDIA/a.jpg', 0, [
    detection(deer, 0.9, 0.88, [0.1, 0.2, 0.3, 0.4]),
    detection(deer, 0.8, 0.8, [0.5, 0.4, 0.2, 0.2]),
    detection(fox, 0.9, 0.7, [0.2, 0.3, 0.2, 0.2]),
  ]);
  const second = makePhoto('card/DCIM/100MEDIA/b.jpg', 20_000, [
    detection(deer, 0.6, 0.6, [0.3, 0.4, 0.2, 0.2]),
  ]);
  const third = makePhoto('card/DCIM2/c.jpg', 300_000, [
    detection(fox, 0.8, 0.8, [0.4, 0.5, 0.1, 0.1]),
  ]);
  const photos = [first.photo, second.photo, third.photo];
  return {
    results: [third.stored, first.stored, second.stored],
    events: groupEvents(photos),
    corrections: { [`card/DCIM@${wallClockMs}\u0000${deer}`]: 'Deer' },
    created: '2026-11-01T02:03:04Z',
    contributors: [{ title: 'Test contributor' }],
    project: {
      title: 'Test project',
      samplingDesign: 'opportunistic' as const,
      individualAnimals: false,
    },
    locations: { 'card/DCIM': location, 'card/DCIM2': { latitude: 0, longitude: 0 } },
  };
}

test('writes one deployment per camera key so DCF rollover stays together', () => {
  const files = toCamtrapDp(input());

  expect(files.deployments).toBe(
    [
      DEPLOYMENT_COLUMNS.join(','),
      row(DEPLOYMENT_COLUMNS, {
        deploymentID: 'card/DCIM',
        locationID: 'loc1',
        locationName: 'Białowieża MRI 01',
        latitude: 52.70442,
        longitude: 23.84995,
        coordinateUncertainty: 100,
        deploymentStart: '2026-11-01T02:03:04Z',
        deploymentEnd: '2026-11-01T02:03:24Z',
        timestampIssues: false,
      }),
      row(DEPLOYMENT_COLUMNS, {
        deploymentID: 'card/DCIM2',
        latitude: 0,
        longitude: 0,
        deploymentStart: '2026-11-01T02:08:04Z',
        deploymentEnd: '2026-11-01T02:08:04Z',
        timestampIssues: false,
      }),
      '',
    ].join('\r\n'),
  );
});

test('writes every successful photo as media in path order', () => {
  const files = toCamtrapDp(input());

  expect(files.media).toBe(
    [
      MEDIA_COLUMNS.join(','),
      row(MEDIA_COLUMNS, {
        mediaID: 'card/DCIM/100MEDIA/a.jpg',
        deploymentID: 'card/DCIM',
        captureMethod: 'activityDetection',
        timestamp: '2026-11-01T02:03:04Z',
        filePath: 'card/DCIM/100MEDIA/a.jpg',
        filePublic: false,
        fileName: 'a.jpg',
        fileMediatype: 'image/jpeg',
      }),
      row(MEDIA_COLUMNS, {
        mediaID: 'card/DCIM/100MEDIA/b.jpg',
        deploymentID: 'card/DCIM',
        captureMethod: 'activityDetection',
        timestamp: '2026-11-01T02:03:24Z',
        filePath: 'card/DCIM/100MEDIA/b.jpg',
        filePublic: false,
        fileName: 'b.jpg',
        fileMediatype: 'image/jpeg',
      }),
      row(MEDIA_COLUMNS, {
        mediaID: 'card/DCIM2/c.jpg',
        deploymentID: 'card/DCIM2',
        captureMethod: 'activityDetection',
        timestamp: '2026-11-01T02:08:04Z',
        filePath: 'card/DCIM2/c.jpg',
        filePublic: false,
        fileName: 'c.jpg',
        fileMediatype: 'image/jpeg',
      }),
      '',
    ].join('\r\n'),
  );
});

test('writes event observations with MaxN and marks a corrected event as human', () => {
  const files = toCamtrapDp(input());

  expect(files.observations).toBe(
    [
      OBSERVATION_COLUMNS.join(','),
      row(OBSERVATION_COLUMNS, {
        observationID: 'card/DCIM@1793498584000:Deer',
        deploymentID: 'card/DCIM',
        eventID: 'card/DCIM@1793498584000',
        eventStart: '2026-11-01T02:03:04Z',
        eventEnd: '2026-11-01T02:03:24Z',
        observationLevel: 'event',
        observationType: 'animal',
        scientificName: '',
        count: 2,
        classificationMethod: 'human',
        classifiedBy: 'Human correction',
        observationComments: `Machine label: ${deer}; score: 0.88`,
      }),
      row(OBSERVATION_COLUMNS, {
        observationID: 'card/DCIM@1793498584000:fox-uuid',
        deploymentID: 'card/DCIM',
        eventID: 'card/DCIM@1793498584000',
        eventStart: '2026-11-01T02:03:04Z',
        eventEnd: '2026-11-01T02:03:24Z',
        observationLevel: 'event',
        observationType: 'animal',
        scientificName: 'vulpes vulpes',
        count: 1,
        classificationMethod: 'machine',
        classifiedBy: 'SpeciesNet v4.0.3a via Deerdiary',
        classificationProbability: 0.7,
      }),
      row(OBSERVATION_COLUMNS, {
        observationID: 'card/DCIM2@1793498884000:fox-uuid',
        deploymentID: 'card/DCIM2',
        eventID: 'card/DCIM2@1793498884000',
        eventStart: '2026-11-01T02:08:04Z',
        eventEnd: '2026-11-01T02:08:04Z',
        observationLevel: 'event',
        observationType: 'animal',
        scientificName: 'vulpes vulpes',
        count: 1,
        classificationMethod: 'machine',
        classifiedBy: 'SpeciesNet v4.0.3a via Deerdiary',
        classificationProbability: 0.8,
      }),
      '',
    ].join('\r\n'),
  );
});

test('writes the official Camtrap DP 1.0.2 profile and the three table schemas', () => {
  const written = JSON.parse(toCamtrapDp(input()).datapackage);

  expect(written.$schema).toBe(CAMTRAP_DP_PROFILE_URL);
  expect(written.profile).toBe(CAMTRAP_DP_PROFILE_URL);
  expect(written.version).toBe('1.0.2');
  expect(written.created).toBe('2026-11-01T02:03:04Z');
  expect(written.project).toEqual({
    ...input().project,
    captureMethod: ['activityDetection'],
    observationLevel: ['event'],
  });
  expect(written.contributors).toEqual([{ title: 'Test contributor' }]);
  expect(written.spatial).toEqual({
    type: 'MultiPoint',
    coordinates: [
      [23.84995, 52.70442],
      [0, 0],
    ],
  });
  expect(written.temporal).toEqual({ start: '2026-11-01', end: '2026-11-01' });
  expect(written.taxonomic).toEqual([{ scientificName: 'vulpes vulpes' }]);
  expect(written.resources.map((resource: { path: string }) => resource.path)).toEqual([
    'deployments.csv',
    'media.csv',
    'observations.csv',
  ]);
  expect(written.resources.map((resource: { schema: string }) => resource.schema)).toEqual([
    'https://raw.githubusercontent.com/tdwg/camtrap-dp/1.0.2/deployments-table-schema.json',
    'https://raw.githubusercontent.com/tdwg/camtrap-dp/1.0.2/media-table-schema.json',
    'https://raw.githubusercontent.com/tdwg/camtrap-dp/1.0.2/observations-table-schema.json',
  ]);
});

test('blocks missing deployment coordinates and names every missing deployment', () => {
  const { results, events, created } = input();
  expect(() => toCamtrapDp({ results, events, created })).toThrow(
    /latitude and longitude.*card\/DCIM, card\/DCIM2/,
  );
  expect(() => toCamtrapDp({ ...input(), locations: { 'card/DCIM': location } })).toThrow(
    /latitude and longitude.*card\/DCIM2/,
  );
});

test.each([
  { latitude: Number.NaN, longitude: 0 },
  { latitude: 91, longitude: 0 },
  { latitude: 0, longitude: -181 },
  { latitude: 0, longitude: Number.POSITIVE_INFINITY },
])('blocks invalid deployment coordinates: %j', (invalid) => {
  expect(() => toCamtrapDp({ ...input(), locations: { 'card/DCIM': invalid } })).toThrow(
    /latitude and longitude.*card\/DCIM/,
  );
});

test('exports whole-second timestamps with camera offsets and deployment-specific coordinates', async () => {
  const first = makePhoto('card/DCIM/a.jpg', -877, [detection(fox, 0.8, 0.8, [0, 0, 1, 1])]);
  const last = makePhoto('card/DCIM/b.jpg', 25_999, []);
  first.stored.time.offsetTimeOriginal = '+05:30';
  last.stored.time.offsetTimeOriginal = '-04:00';
  const data = input();
  const files = toCamtrapDp({
    ...data,
    results: [...data.results, first.stored, last.stored],
    events: groupEvents([first.photo, last.photo]),
  });
  expect(files.deployments).toContain(
    '52.70442,23.84995,100,2026-11-01T02:03:03+05:30,2026-11-01T02:03:29-04:00',
  );
  expect(files.deployments).toContain('card/DCIM2,,,0,0,');
  expect(files.media).toContain('2026-11-01T02:03:03+05:30');
  expect(files.media).toContain('2026-11-01T02:03:29-04:00');
  expect(files.observations).toContain('2026-11-01T02:03:03+05:30,2026-11-01T02:03:29-04:00');
  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/;
  for (const [csv, indexes] of [
    [files.deployments, [6, 7]],
    [files.media, [3]],
    [files.observations, [4, 5]],
  ] as const) {
    for (const line of csv.trim().split('\r\n').slice(1)) {
      for (const index of indexes) expect(line.split(',')[index]).toMatch(timestamp);
    }
  }
  // Keep a freshly exported package for the independent Frictionless check.
  const directory = process.env.CAMTRAP_VALIDATION_DIR;
  if (directory === undefined) return;
  for (const [name, text] of Object.entries(files)) {
    await writeFile(
      join(directory, name === 'datapackage' ? 'datapackage.json' : `${name}.csv`),
      text,
    );
  }
});

test('quotes a comma in a media path', () => {
  const photo = makePhoto('card/DCIM/a,b.jpg', 0, []);
  const files = toCamtrapDp({
    project: input().project,
    contributors: input().contributors,
    locations: { 'card/DCIM': location },
    results: [photo.stored],
    events: [],
    created: '2026-11-01T02:03:04Z',
  });

  expect(files.media).toContain('"card/DCIM/a,b.jpg",card/DCIM');
});

test('serializes the replacement scientific name for a human correction', () => {
  const data = input();
  data.corrections = { [`card/DCIM@${wallClockMs}\u0000${deer}`]: fox };
  const csv = toCamtrapDp(data).observations;
  const corrected = csv.split('\r\n')[1]?.split(',');
  expect(corrected?.[9]).toBe('vulpes vulpes');
  expect(corrected?.[22]).toBe('human');
  expect(corrected?.[25]).toBe('');
  expect(csv).toContain(deer);
});

test('merges corrected and existing species into one observation with the corrected MaxN', () => {
  const data = input();
  data.corrections = { [`card/DCIM@${wallClockMs}\u0000${deer}`]: fox };
  const rows = toCamtrapDp(data).observations.trim().split('\r\n').slice(1);
  expect(rows).toHaveLength(2);
  expect(rows[0]?.split(',')[10]).toBe('2');
});

test('blocks package metadata it cannot infer rather than inventing a sampling design', () => {
  const { project: _project, ...data } = input();
  expect(() => toCamtrapDp(data)).toThrow(/project title and sampling design/);
});

test('rejects malformed camera timezone offsets', () => {
  const data = input();
  for (const result of data.results) result.time.offsetTimeOriginal = '+25:00';
  expect(() => toCamtrapDp(data)).toThrow(/camera timezone offset/);
});

test('requires an identified contributor for the official package profile', () => {
  expect(() => toCamtrapDp({ ...input(), contributors: [] })).toThrow(/contributor/);
});

test.each(['human', 'vehicle', 'blank'])(
  'preserves a correction to %s in event observations',
  (label) => {
    const data = input();
    data.corrections = { [`card/DCIM@${wallClockMs}\u0000${deer}`]: label };
    const rows = toCamtrapDp(data)
      .observations.trim()
      .split('\r\n')
      .slice(1)
      .map((line) => line.split(','));
    const corrected = rows.find((row) => row[7] === label);
    expect(corrected).toBeDefined();
    expect(corrected?.[10]).toBe(label === 'blank' ? '' : '2');
    expect(corrected?.[22]).toBe('human');
    expect(corrected?.[25]).toBe('');
    expect(corrected?.[27]).toContain(deer);
  },
);

test.each(['human', 'vehicle', 'blank'])('exports a machine-only %s burst', (label) => {
  const photo = makePhoto('card/DCIM/a.jpg', 0, [detection(label, 0.9, 0.8, [0, 0, 1, 1])]);
  const csv = toCamtrapDp({
    ...input(),
    results: [photo.stored],
    events: groupEvents([photo.photo]),
    corrections: {},
  }).observations;
  const row = csv.trim().split('\r\n')[1]?.split(',');
  expect(row?.[7]).toBe(label);
  expect(row?.[10]).toBe(label === 'blank' ? '' : '1');
  expect(row?.[22]).toBe('machine');
  expect(row?.[25]).toBe('0.8');
});

test('exports a blank burst without inventing individuals or confidence', () => {
  const photo = makePhoto('card/DCIM/a.jpg', 0, []);
  const row = toCamtrapDp({
    ...input(),
    results: [photo.stored],
    events: groupEvents([photo.photo]),
    corrections: {},
  })
    .observations.trim()
    .split('\r\n')[1]
    ?.split(',');
  expect(row?.[7]).toBe('blank');
  expect(row?.[10]).toBe('');
  expect(row?.[25]).toBe('');
});

test('keeps unknown observations without inventing a scientific name or individual count', () => {
  const label = 'id;no cv result;no cv result;no cv result;no cv result;no cv result;no cv result';
  const photo = makePhoto('card/DCIM/a.jpg', 0, [detection(label, 0.9, 0, [0, 0, 1, 1])]);
  const row = toCamtrapDp({
    ...input(),
    results: [photo.stored],
    events: groupEvents([photo.photo]),
    corrections: {},
  })
    .observations.trim()
    .split('\r\n')[1]
    ?.split(',');
  expect(row?.[7]).toBe('unknown');
  expect(row?.[9]).toBe('');
  expect(row?.[10]).toBe('');
  expect(row?.[25]).toBe('0');
});
