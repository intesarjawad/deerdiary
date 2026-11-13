import { beforeEach, expect, test, vi } from 'vitest';
import {
  exclusiveCorrectionKeys,
  firstSightings,
  type SessionSummary,
  sessionCorrections,
  sessionSummaries,
} from '../../src/core/history';
import { Classification } from '../../src/core/labels';
import type { CameraTime } from '../../src/core/time';
import { PhotoStorage } from '../../src/storage/db';
import type { Session, StoredResult } from '../../src/storage/schema';
import { dateRangeLabel, exportSession, restoreSession } from '../../src/ui/History';
import type {
  ClassifiedDetection,
  PhotoResult as WorkerPhotoResult,
} from '../../src/workers/photo';

const disk = vi.hoisted(() => ({
  stores: new Map<string, Map<string, unknown>>(),
  transactions: [] as { stores: string[]; mode: string | undefined }[],
}));

vi.mock('idb', () => {
  const store = (name: string) => {
    const entries = disk.stores.get(name);
    if (!entries) throw new Error(`Unknown object store: ${name}`);
    return entries;
  };
  const database = {
    close() {},
    async getAll(name: string) {
      return structuredClone(Array.from(store(name).values()));
    },
    transaction(names: string | string[], mode?: string) {
      const stores = typeof names === 'string' ? [names] : names;
      disk.transactions.push({ stores, mode });
      const writes: (() => void)[] = [];
      const objectStore = (name: string) => ({
        async getAll() {
          return structuredClone(Array.from(store(name).values()));
        },
        async getAllKeys() {
          return Array.from(store(name).keys());
        },
        async delete(key: string) {
          writes.push(() => store(name).delete(key));
        },
        async put(value: { key?: string; id?: string } | string, explicitKey?: string) {
          const key =
            explicitKey ?? (typeof value === 'string' ? undefined : (value.key ?? value.id));
          if (!key) throw new Error('Expected an inline key');
          const copy = structuredClone(value);
          writes.push(() => store(name).set(key, copy));
        },
      });
      return {
        store: objectStore(stores[0] ?? ''),
        objectStore,
        get done() {
          return Promise.resolve().then(() => {
            for (const write of writes) write();
          });
        },
      };
    },
  };
  return {
    async openDB(_name: string, _version: number, options: { upgrade(db: unknown): void }) {
      options.upgrade({
        createObjectStore(name: string) {
          disk.stores.set(name, new Map());
        },
      });
      return database;
    },
  };
});

beforeEach(() => {
  disk.stores.clear();
  disk.transactions.length = 0;
});

const deer = 'deer-id;mammalia;artiodactyla;cervidae;odocoileus;virginianus;white-tailed deer';
const fox = 'fox-id;mammalia;carnivora;canidae;vulpes;vulpes;red fox';
const badger = 'badger-id;mammalia;carnivora;mustelidae;meles;meles;eurasian badger';
const minute = 60_000;
const start = Date.UTC(2026, 3, 1, 6);

const times = {
  decode: 0,
  preprocess: 0,
  detect: 0,
  classify: 0,
  ensemble: 0,
  thumbnail: 0,
  total: 0,
};

function timeAt(offsetMs: number): CameraTime {
  return {
    wallClockMs: start + offsetMs,
    wallClockHour: 6,
    timeSource: 'exif',
    offsetTimeOriginal: null,
    clockStatus: 'ok',
  };
}

function box(label: string): ClassifiedDetection {
  return {
    category: '1',
    label: 'animal',
    conf: 0.9,
    bbox: [0, 0, 0.5, 0.5],
    processed_classification: { class: label, score: 0.9, source: 'classifier' },
  };
}

function result(path: string, offsetMs: number, labels: readonly string[]): StoredResult {
  const output: WorkerPhotoResult = {
    path,
    backend: 'wasm',
    ms: times,
    status: 'ok',
    width: 160,
    height: 120,
    thumbnail: new Blob(['thumbnail']),
    detections: labels.map((label) => box(label)),
  };
  return { key: `${path}|1|2`, time: timeAt(offsetMs), output };
}

function broken(path: string, offsetMs: number): StoredResult {
  return {
    key: `${path}|1|2`,
    time: timeAt(offsetMs),
    output: { path, backend: 'wasm', ms: times, status: 'decode_failed' },
  };
}

function session(id: string, createdAtMs: number, stored: readonly StoredResult[]): Session {
  const readings = stored.map(({ time }) => time.wallClockMs);
  return {
    id,
    createdAtMs,
    fileKeys: stored.map(({ key }) => key),
    dateRange:
      readings.length === 0 ? null : { first: Math.min(...readings), last: Math.max(...readings) },
  };
}

test('lists the newest diary first with its date range, photos and independent species', () => {
  const spring = [
    result('a/1.jpg', 0, [deer]),
    result('a/2.jpg', 10_000, [deer]),
    result('a/3.jpg', 40 * minute, [fox]),
    result('b/1.jpg', 41 * minute, [Classification.BLANK]),
    broken('c/broken.jpg', 30 * minute),
  ];
  const autumn = [result('d/1.jpg', 120 * minute, [deer])];

  const summaries = sessionSummaries(
    [session('spring', 1_000, spring), session('autumn', 5_000, autumn)],
    [...spring, ...autumn],
  );

  expect(summaries).toEqual([
    {
      id: 'autumn',
      createdAtMs: 5_000,
      dateRange: { first: start + 120 * minute, last: start + 120 * minute },
      photoCount: 1,
      species: [{ label: deer, name: 'white-tailed deer', detections: 1 }],
    },
    {
      id: 'spring',
      createdAtMs: 1_000,
      dateRange: { first: start, last: start + 41 * minute },
      photoCount: 4,
      species: [
        { label: deer, name: 'white-tailed deer', detections: 1 },
        { label: fox, name: 'red fox', detections: 1 },
      ],
    },
  ]);
});

test('counts one detection per burst and drops the detector fallbacks', () => {
  const labels = [
    deer,
    fox,
    Classification.ANIMAL,
    'unknown-id;;;;;;unknown',
    Classification.UNKNOWN,
    Classification.BLANK,
    Classification.HUMAN,
    Classification.VEHICLE,
  ];
  const stored = [result('camera/a.jpg', 0, labels)];

  expect(sessionSummaries([session('drop', 1_000, stored)], stored)[0]?.species).toEqual([
    { label: deer, name: 'white-tailed deer', detections: 1 },
    { label: fox, name: 'red fox', detections: 1 },
  ]);
});

test('counts a species again only after the independence interval', () => {
  const stored = [
    result('camera/a.jpg', 0, [deer]),
    result('camera/b.jpg', 29 * minute, [deer]),
    result('camera/c.jpg', 31 * minute, [deer]),
  ];

  expect(sessionSummaries([session('drop', 1_000, stored)], stored)[0]?.species).toEqual([
    { label: deer, name: 'white-tailed deer', detections: 2 },
  ]);
});

test('replaces the label and the shown name with a saved correction', () => {
  const stored = [result('camera/a.jpg', 0, [deer])];
  const corrections = { [`camera@${start}\u0000${deer}`]: 'Deer' };

  expect(
    sessionSummaries([session('drop', 1_000, stored)], stored, corrections)[0]?.species,
  ).toEqual([{ label: 'Deer', name: 'Deer', detections: 1 }]);
});

test('reports a diary with no results as empty rather than missing', () => {
  expect(sessionSummaries([session('drop', 1_000, [])], [])).toEqual([
    { id: 'drop', createdAtMs: 1_000, dateRange: null, photoCount: 0, species: [] },
  ]);
});

test('a first sighting is absent from every earlier diary, not only the previous one', () => {
  const earlier: SessionSummary = {
    id: 'first',
    createdAtMs: 1_000,
    dateRange: { first: start, last: start },
    photoCount: 2,
    species: [{ label: deer, name: 'white-tailed deer', detections: 2 }],
  };
  const current: SessionSummary = {
    id: 'current',
    createdAtMs: 2_000,
    dateRange: { first: start + minute, last: start + minute },
    photoCount: 2,
    species: [
      { label: deer, name: 'white-tailed deer', detections: 1 },
      { label: fox, name: 'red fox', detections: 1 },
    ],
  };
  const later: SessionSummary = {
    id: 'later',
    createdAtMs: 3_000,
    dateRange: null,
    photoCount: 2,
    species: [
      { label: fox, name: 'red fox', detections: 1 },
      { label: badger, name: 'eurasian badger', detections: 1 },
    ],
  };

  expect(firstSightings([later, current, earlier], current)).toEqual([
    { label: fox, name: 'red fox', detections: 1 },
  ]);
});

test('with no earlier diary every species of the current one is new', () => {
  const stored = [result('camera/a.jpg', 0, [deer, fox])];
  const [current] = sessionSummaries([session('only', 1_000, stored)], stored);
  if (!current) throw new Error('Expected one summary');

  expect(firstSightings([current], current)).toEqual([
    { label: deer, name: 'white-tailed deer', detections: 1 },
    { label: fox, name: 'red fox', detections: 1 },
  ]);
});

test('a corrected label decides what counts as new, in the earlier and the current diary', () => {
  const earlier = [result('other/a.jpg', 0, [deer])];
  const now = [result('camera/a.jpg', 0, [fox]), result('camera/b.jpg', 10 * minute, [deer])];
  const sessions = [session('earlier', 1_000, earlier), session('now', 2_000, now)];
  const corrections = {
    [`camera@${start}\u0000${fox}`]: badger,
    [`other@${start}\u0000${deer}`]: fox,
  };

  const summaries = sessionSummaries(sessions, [...earlier, ...now], corrections);
  const current = summaries.find(({ id }) => id === 'now');
  if (!current) throw new Error('Expected the current summary');

  expect(firstSightings(summaries, current).map(({ label }) => label)).toEqual([badger, deer]);
});

test('the detector fallbacks are never a first sighting', () => {
  const species = (label: string) => ({
    label,
    name: label.split(';').at(-1) ?? label,
    detections: 1,
  });
  const current: SessionSummary = {
    id: 'current',
    createdAtMs: 2_000,
    dateRange: null,
    photoCount: 1,
    species: [
      species(Classification.ANIMAL),
      species(Classification.UNKNOWN),
      species(Classification.BLANK),
      species(Classification.HUMAN),
      species(Classification.VEHICLE),
      species('unknown-id;;;;;;unknown'),
      species(deer),
    ],
  };

  expect(firstSightings([current], current)).toEqual([species(deer)]);
});

test('lists the corrections a diary uses, and those only it uses', () => {
  const a = result('cam1/a.jpg', 0, [deer]);
  const b = result('cam2/b.jpg', 0, [fox]);
  const one = session('one', 1_000, [a]);
  const two = session('two', 2_000, [a, b]);
  const corrections = {
    [`cam1@${start}\u0000${deer}`]: 'Elk',
    [`cam2@${start}\u0000${fox}`]: 'Dog',
    [`cam3@${start}\u0000${fox}`]: 'Cat',
  };

  expect(sessionCorrections(two, [a, b], corrections)).toEqual({
    [`cam1@${start}\u0000${deer}`]: 'Elk',
    [`cam2@${start}\u0000${fox}`]: 'Dog',
  });
  expect(exclusiveCorrectionKeys(one, [two], [a, b], corrections)).toEqual([]);
  expect(exclusiveCorrectionKeys(two, [one], [a, b], corrections)).toEqual([
    `cam2@${start}\u0000${fox}`,
  ]);
});

test('names the date range by day, as the camera wrote it', () => {
  expect(dateRangeLabel(null)).toBe('No dated photos');
  expect(dateRangeLabel({ first: start, last: start + 41 * minute })).toBe('2026-04-01');
  expect(dateRangeLabel({ first: start, last: start + 48 * 60 * minute })).toBe(
    '2026-04-01 to 2026-04-03',
  );
});

test('an exported session imports back with its row, photos and corrections', () => {
  const stored = [
    result('cam1/a.jpg', 0, [deer]),
    result('cam1/b.jpg', 5 * minute, [Classification.BLANK]),
    broken('cam1/c.jpg', 90 * minute),
  ];
  const mine = session('mine', 7_000, stored);
  const key = `cam1@${start}\u0000${deer}`;
  const corrections = { [key]: 'Elk', [`cam9@${start}\u0000${fox}`]: 'Cat' };

  const file = exportSession(mine, stored, corrections);
  const written = JSON.parse(file.text);
  const restored = restoreSession(file.text);

  expect(written.deerdiary.corrections).toEqual({ [key]: 'Elk' });
  expect(written.predictions).toHaveLength(3);
  if (!restored.ok) throw new Error(`Expected a restored session, got ${restored.field}`);
  expect(restored.value.session).toEqual({
    id: 'mine',
    createdAtMs: 7_000,
    fileKeys: ['cam1/a.jpg|1|2', 'cam1/b.jpg|1|2', 'cam1/c.jpg|1|2'],
    dateRange: { first: start, last: start + 90 * minute },
  });
  expect(restored.value.corrections).toEqual({ [key]: 'Elk' });
  expect(restored.value.results.map(({ key, time }) => [key, time.wallClockMs])).toEqual([
    ['cam1/a.jpg|1|2', start],
    ['cam1/b.jpg|1|2', start + 5 * minute],
    ['cam1/c.jpg|1|2', start + 90 * minute],
  ]);
  expect(
    sessionSummaries([restored.value.session], restored.value.results, restored.value.corrections),
  ).toEqual(sessionSummaries([mine], stored, { [key]: 'Elk' }));
});

test('a prediction file from elsewhere is not a session export', () => {
  const plain = JSON.stringify({ info: { format_version: '1' }, predictions: [] });

  expect(restoreSession(plain)).toEqual({ ok: false, field: 'deerdiary.session' });
  expect(restoreSession('{"predictions":')).toEqual({ ok: false, field: 'root' });
});

test('deleting a session removes its rows in one transaction and keeps shared ones', async () => {
  const storage = await PhotoStorage.open();
  const shared = result('cam1/a.jpg', 0, [deer]);
  const only = result('cam2/b.jpg', 0, [fox]);
  const keepKey = `cam1@${start}\u0000${deer}`;
  const dropKey = `cam2@${start}\u0000${fox}`;
  await storage.restoreSession(session('one', 1_000, [shared]), [shared], { [keepKey]: 'Elk' });
  await storage.restoreSession(session('two', 2_000, [shared, only]), [shared, only], {
    [dropKey]: 'Dog',
  });
  disk.transactions.length = 0;

  await storage.deleteSession('two', [dropKey]);

  expect(disk.transactions).toEqual([
    { stores: ['files', 'results', 'corrections', 'sessions'], mode: 'readwrite' },
  ]);
  expect(Array.from(disk.stores.get('sessions')?.keys() ?? [])).toEqual(['one']);
  expect(Array.from(disk.stores.get('results')?.keys() ?? [])).toEqual(['cam1/a.jpg|1|2']);
  expect(Array.from(disk.stores.get('corrections')?.keys() ?? [])).toEqual([keepKey]);
  expect((await storage.listSessions()).map(({ id }) => id)).toEqual(['one']);
  expect(await storage.loadCorrections()).toEqual({ [keepKey]: 'Elk' });
});

test.each([
  ['wallClockMs', 1e99],
  ['wallClockMs', -1e99],
  ['wallClockHour', -1],
  ['wallClockHour', 24],
  ['wallClockHour', 2.5],
])('rejects invalid imported camera time %s=%s before persistence', (field, value) => {
  const stored = [result('cam/a.jpg', 0, [deer])];
  const raw = JSON.parse(exportSession(session('bad', 1000, stored), stored, {}).text);
  raw.deerdiary.session.photos[0].time[field] = value;
  expect(restoreSession(JSON.stringify(raw))).toEqual({ ok: false, field: 'deerdiary.session' });
});

test('rejects an invalid session creation date', () => {
  const raw = JSON.parse(exportSession(session('bad', 1e99, []), [], {}).text);
  expect(restoreSession(JSON.stringify(raw))).toEqual({ ok: false, field: 'deerdiary.session' });
});

test('an already stored invalid date cannot crash the History recovery controls', () => {
  expect(dateRangeLabel({ first: 1e99, last: start })).toBe('Invalid saved date');
});

test('applies corrections before counting independent sightings of the same species', () => {
  const stored = [result('cam/a.jpg', 0, [deer]), result('cam/b.jpg', 10 * minute, [fox])];
  const corrections = { [`cam@${start}\u0000${deer}`]: fox };
  expect(
    sessionSummaries([session('merged', 1000, stored)], stored, corrections)[0]?.species,
  ).toEqual([{ label: fox, name: 'red fox', detections: 1 }]);
});

test('restored corrections can be reset to their original machine classification', () => {
  const stored = [result('cam/a.jpg', 0, [deer])];
  const key = `cam@${start}\u0000${deer}`;
  const exported = exportSession(session('mine', 1000, stored), stored, { [key]: fox });
  const restored = restoreSession(exported.text);
  if (!restored.ok) throw new Error(restored.field);
  expect(
    sessionSummaries(
      [restored.value.session],
      restored.value.results,
      restored.value.corrections,
    )[0]?.species[0]?.label,
  ).toBe(fox);
  expect(
    sessionSummaries([restored.value.session], restored.value.results, {})[0]?.species[0]?.label,
  ).toBe(deer);
});

test('session backups restore incomplete Camtrap drafts and reject malformed metadata', () => {
  const stored = [result('cam1/a.jpg', 0, [deer])];
  const mine = session('metadata', 7000, stored);
  mine.camtrap = {
    projectTitle: 'Survey',
    contributor: 'Researcher',
    samplingDesign: '',
    individualAnimals: false,
    locations: { cam1: { latitude: '34.1', longitude: '' } },
  };
  const exported = exportSession(mine, stored, {});
  const restored = restoreSession(exported.text);
  expect(restored.ok && restored.value.session.camtrap).toEqual(mine.camtrap);
  const malformed = JSON.parse(exported.text);
  malformed.deerdiary.session.camtrap.locations.cam1.latitude = 34.1;
  expect(restoreSession(JSON.stringify(malformed))).toEqual({
    ok: false,
    field: 'deerdiary.session',
  });
});
