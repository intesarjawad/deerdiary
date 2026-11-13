import { beforeEach, expect, it, vi } from 'vitest';
import { PhotoStorage } from '../../src/storage/db';
import { fileKey, type StorageBatch } from '../../src/storage/schema';

const disk = vi.hoisted(() => ({
  stores: new Map<string, Map<string, unknown>>(),
  openError: undefined as Error | undefined,
  writeError: undefined as Error | undefined,
  transactions: [] as { stores: string[]; mode: string | undefined }[],
  close: vi.fn(),
}));

vi.mock('idb', () => {
  const store = (name: string) => {
    const entries = disk.stores.get(name);
    if (!entries) throw new Error(`Unknown object store: ${name}`);
    return entries;
  };
  const database = {
    createObjectStore(name: string) {
      disk.stores.set(name, new Map());
    },
    close: disk.close,
    async get(name: string, key: string) {
      return structuredClone(store(name).get(key));
    },
    async getAll(name: string) {
      return structuredClone(Array.from(store(name).values()));
    },
    async put(name: string, value: unknown, key: string) {
      if (disk.writeError) throw disk.writeError;
      store(name).set(key, structuredClone(value));
    },
    async delete(name: string, key: string) {
      if (disk.writeError) throw disk.writeError;
      store(name).delete(key);
    },
    transaction(names: string | string[], mode?: string) {
      const stores = typeof names === 'string' ? [names] : names;
      disk.transactions.push({ stores, mode });
      const writes: (() => void)[] = [];
      const objectStore = (name: string) => ({
        get: (key: string) => database.get(name, key),
        async getAll() {
          return Array.from(store(name).values());
        },
        async getAllKeys() {
          return Array.from(store(name).keys());
        },
        async delete(key: string) {
          if (disk.writeError) throw disk.writeError;
          writes.push(() => store(name).delete(key));
        },
        async put(value: { key?: string; id?: string } | string, explicitKey?: string) {
          const key =
            explicitKey ?? (typeof value === 'string' ? undefined : (value.key ?? value.id));
          if (!key) throw new Error('Expected an inline key');
          const copy = structuredClone(value);
          writes.push(() => store(name).set(key, copy));
          return key;
        },
      });
      return {
        store: objectStore(stores[0] ?? ''),
        objectStore,
        get done() {
          return Promise.resolve().then(() => {
            if (mode === 'readwrite' && disk.writeError) throw disk.writeError;
            for (const write of writes) write();
          });
        },
      };
    },
  };
  return {
    async openDB(name: string, version: number, options: { upgrade(db: typeof database): void }) {
      expect([name, version]).toEqual(['deerdiary', 1]);
      if (disk.openError) throw disk.openError;
      if (disk.stores.size === 0) options.upgrade(database);
      return database;
    },
  };
});

function batch(): StorageBatch {
  const file = { path: 'camera/photo.jpg', sizeBytes: 123, mtimeMs: 456 };
  const key = fileKey(file);
  return {
    files: [{ ...file, key }],
    results: [
      {
        key,
        time: {
          wallClockMs: 1000,
          wallClockHour: 0,
          timeSource: 'exif',
          offsetTimeOriginal: null,
          clockStatus: 'ok',
        },
        output: {
          path: file.path,
          backend: 'wasm',
          status: 'ok',
          width: 100,
          height: 200,
          ms: {
            decode: 0,
            preprocess: 0,
            detect: 0,
            classify: 0,
            ensemble: 0,
            thumbnail: 0,
            total: 0,
          },
          thumbnail: new Blob(['thumbnail']),
          detections: [
            {
              category: '1',
              conf: 0.9,
              bbox: [0, 0, 1, 1],
              label: 'animal',
              raw_classifications: {
                classes: ['a', 'b', 'c', 'd', 'e'],
                scores: [0.8, 0.1, 0.05, 0.03, 0.02],
              },
              processed_classification: { class: 'a', score: 0.8, source: 'classifier' },
            },
          ],
        },
      },
    ],
    session: {
      id: 'drop',
      createdAtMs: 2000,
      fileKeys: [key],
      dateRange: { first: 1000, last: 1000 },
    },
  };
}

beforeEach(() => {
  disk.stores.clear();
  disk.transactions = [];
  disk.openError = undefined;
  disk.writeError = undefined;
  disk.close.mockClear();
});

it('creates all five stores and atomically persists raw outputs, previews and session metadata', async () => {
  const storage = await PhotoStorage.open();
  const input = batch();
  await storage.saveBatch(input);
  await storage.saveLocation({ country: 'USA', admin1Region: 'CA' });
  storage.close();
  expect(Array.from(disk.stores.keys())).toEqual([
    'files',
    'results',
    'corrections',
    'sessions',
    'settings',
  ]);
  expect(disk.transactions[0]).toEqual({
    stores: ['files', 'results', 'sessions'],
    mode: 'readwrite',
  });
  expect(disk.stores.get('files')?.get(input.files[0]?.key ?? '')).toEqual(input.files[0]);
  const reopened = await PhotoStorage.open();
  expect(await reopened.loadResults([...input.session.fileKeys, 'missing'])).toEqual(input.results);
  expect(await reopened.listSessions()).toEqual([input.session]);
  expect(await reopened.loadLocation()).toEqual({ country: 'USA', admin1Region: 'CA' });
  expect(reopened.memoryOnly).toBe(false);
  expect(disk.close).toHaveBeenCalledOnce();
});

it('keeps failed quota batches and later results in memory without partial disk writes', async () => {
  const storage = await PhotoStorage.open();
  const first = batch();
  await storage.saveBatch(first);
  const next = batch();
  next.session.id = 'next-drop';
  next.session.dateRange = null;
  disk.writeError = new DOMException('Storage is full', 'QuotaExceededError');
  await storage.saveBatch(next);
  await storage.saveLocation({ country: 'GBR' });
  expect(storage.memoryOnly).toBe(true);
  expect(await storage.loadResults(next.session.fileKeys)).toEqual(next.results);
  expect(await storage.listSessions()).toEqual([first.session, next.session]);
  expect(await storage.loadLocation()).toEqual({ country: 'GBR' });
  expect(disk.stores.get('sessions')?.has('next-drop')).toBe(false);
  expect(disk.stores.get('settings')?.size).toBe(0);
  const reopened = await PhotoStorage.open();
  expect(await reopened.listSessions()).toEqual([first.session]);
});

it('handles quota exhaustion while opening and preserves later session updates', async () => {
  disk.openError = new DOMException('Storage is full', 'QuotaExceededError');
  const storage = await PhotoStorage.open();
  const input = batch();
  await storage.saveBatch(input);
  await storage.saveLocation({});
  expect(await storage.loadLocation()).toEqual({});
  expect(await storage.loadResults(input.session.fileKeys)).toEqual(input.results);
  expect(await storage.listSessions()).toEqual([input.session]);
  expect(storage.memoryOnly).toBe(true);
});

it('propagates other database failures without marking an uncommitted result complete', async () => {
  const storage = await PhotoStorage.open();
  disk.writeError = new DOMException('Transaction failed', 'AbortError');
  const input = batch();
  await expect(storage.saveBatch(input)).rejects.toThrow('Transaction failed');
  expect(await storage.loadResults(input.session.fileKeys)).toEqual([]);
  expect(await storage.listSessions()).toEqual([]);
  expect(storage.memoryOnly).toBe(false);
  disk.openError = new DOMException('Access denied', 'SecurityError');
  await expect(PhotoStorage.open()).rejects.toThrow('Access denied');
});

it('isolates saved records from caller mutations', async () => {
  const storage = await PhotoStorage.open();
  const input = batch();
  await storage.saveBatch(input);
  input.session.fileKeys.push('changed');
  const sessions = await storage.listSessions();
  expect(sessions[0]?.fileKeys).toHaveLength(1);
  const loaded = await storage.loadResults(input.session.fileKeys);
  const result = loaded[0];
  if (result?.output.status !== 'ok') throw new Error('Expected processed photo');
  result.output.detections.length = 0;
  expect(await storage.loadResults(input.session.fileKeys)).not.toEqual(loaded);
});

it('stores corrections under their event-and-species key and resets one entry', async () => {
  const deer = 'card/DCIM@1000\u0000deer-id';
  const fox = 'card/DCIM@1000\u0000fox-id';
  const storage = await PhotoStorage.open();
  await storage.saveCorrection(deer, 'Mule deer');
  await storage.saveCorrection(fox, 'Red fox');

  const reopened = await PhotoStorage.open();
  expect(await reopened.loadCorrections()).toEqual({ [deer]: 'Mule deer', [fox]: 'Red fox' });

  await reopened.deleteCorrection(deer);
  expect(await reopened.loadCorrections()).toEqual({ [fox]: 'Red fox' });

  await reopened.saveCorrections({ [deer]: 'White-tailed deer' });
  expect(await reopened.loadCorrections()).toEqual({ [deer]: 'White-tailed deer' });
});

it('keeps Camtrap drafts with their session across reloads and later photo batches', async () => {
  const storage = await PhotoStorage.open();
  const data = batch();
  await storage.saveBatch(data);
  const draft = {
    projectTitle: 'Survey',
    contributor: 'Researcher',
    samplingDesign: 'targeted',
    individualAnimals: false,
    locations: { camera: { latitude: '', longitude: '-97.5' } },
  };
  await storage.saveCamtrapDraft(data.session.id, draft);
  draft.projectTitle = 'Mutation must not change stored draft';
  await storage.saveBatch(data);
  storage.close();
  const reopened = await PhotoStorage.open();
  expect((await reopened.listSessions())[0]?.camtrap?.projectTitle).toBe('Survey');
  expect((await reopened.listSessions())[0]?.camtrap?.locations.camera?.latitude).toBe('');
  await reopened.deleteSession(data.session.id, []);
  expect(await reopened.listSessions()).toEqual([]);
});
