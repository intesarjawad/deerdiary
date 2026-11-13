import { afterEach, expect, it, vi } from 'vitest';
import { FLUSH_INTERVAL_MS, PhotoPipeline, RATE_WINDOW } from '../../src/app/pipeline';
import { scanFiles } from '../../src/files/scan';
import { fileKey } from '../../src/storage/schema';
import {
  init,
  MemoryStorage,
  output,
  photos,
  readTime,
  session,
  TestWorker,
  time,
} from './fixtures/pipeline';

afterEach(() => {
  vi.useRealTimers();
});

it('resumes completed keys across instances without constructing a worker', async () => {
  const storage = new MemoryStorage();
  const files = photos(3);
  const worker = new TestWorker();
  await new PhotoPipeline({ storage, init, readTime, createWorker: () => worker }).run(
    files,
    session,
    time.wallClockMs,
  );
  const createWorker = vi.fn(() => new TestWorker());
  const resumed = new PhotoPipeline({ storage, init, readTime, createWorker });
  await resumed.run(files, { ...session, id: 'second-drop' }, time.wallClockMs);
  expect(createWorker).not.toHaveBeenCalled();
  expect(resumed.state.progress.value).toMatchObject({
    done: 3,
    total: 3,
    secondsLeft: 0,
    photosPerSecond: 0,
  });
  expect(storage.batches.at(-1)?.session).toEqual({
    id: 'second-drop',
    createdAtMs: session.createdAtMs,
    fileKeys: files.map(fileKey),
    dateRange: { first: time.wallClockMs, last: time.wallClockMs },
  });
  expect(resumed.state.events.value).toHaveLength(1);
});

it('keys include size and mtime, deduplicates intake and processes only photos', async () => {
  const storage = new MemoryStorage();
  const original = photos(1);
  await new PhotoPipeline({ storage, init, readTime, createWorker: () => new TestWorker() }).run(
    original,
    session,
    time.wallClockMs,
  );
  const changed = scanFiles([
    new File(['longer'], '0.jpg', { lastModified: 100 }),
    new File(['jpeg'], '0.jpg', { lastModified: 101 }),
    new File([], 'sound.wav'),
  ]);
  const worker = new TestWorker();
  const pipeline = new PhotoPipeline({ storage, init, readTime, createWorker: () => worker });
  await pipeline.run([...original, ...original, ...changed], session, time.wallClockMs);
  expect(worker.requests).toHaveLength(2);
  expect(pipeline.state.progress.value).toMatchObject({ done: 3, total: 3 });
});

it('flushes batches of 50 and the final partial batch and computes a 20-photo EMA', async () => {
  const storage = new MemoryStorage();
  let clock = 0;
  let count = 0;
  const worker = new TestWorker((request, worker) => {
    clock += count++ === 0 ? 1_000 : 500;
    worker.send(output(request));
  });
  const pipeline = new PhotoPipeline({
    storage,
    init,
    readTime,
    now: () => clock,
    createWorker: () => worker,
  });
  await pipeline.run(photos(103), session, time.wallClockMs);
  expect(
    storage.batches.filter((batch) => batch.results.length).map((batch) => batch.results.length),
  ).toEqual([50, 50, 3]);
  expect(pipeline.state.progress.value.photosPerSecond).toBeCloseTo(
    2 - (1 - 2 / (RATE_WINDOW + 1)) ** 102,
    12,
  );
  expect(storage.results.size).toBe(103);
  expect(pipeline.state.results.value).toHaveLength(103);
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it('flushes after two seconds while the next photo is still in flight', async () => {
  vi.useFakeTimers();
  const storage = new MemoryStorage();
  const worker = new TestWorker((request, worker) => {
    if (worker.requests.length === 1) worker.send(output(request));
  });
  const pipeline = new PhotoPipeline({ storage, init, readTime, createWorker: () => worker });
  const running = pipeline.run(photos(2), session, time.wallClockMs);
  await vi.waitFor(() => expect(worker.requests).toHaveLength(2));
  expect(storage.results.size).toBe(0);
  await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
  expect(storage.results.size).toBe(1);
  expect(pipeline.state.results.value).toHaveLength(1);
  const request = worker.requests[1];
  if (!request) throw new Error('Expected pending photo');
  worker.send(output(request));
  await running;
  expect(storage.results.size).toBe(2);
});

it('reads at most four files ahead and never overlaps inference', async () => {
  const files = photos(8);
  let reads = 0;
  const handled = files.map((file) => ({
    ...file,
    source: {
      getFile: async () => {
        reads++;
        return new File(['jpeg'], file.name);
      },
    },
  }));
  const worker = new TestWorker(() => {});
  const scanned = handled.map((file) => ({
    ...file,
    source: {
      ...file.source,
      kind: 'file' as const,
      isFile: true as const,
      isDirectory: false as const,
      name: file.name,
      isSameEntry: async () => false,
      createWritable: vi.fn(),
      getFile: file.source.getFile,
      queryPermission: vi.fn(),
      requestPermission: vi.fn(),
      move: vi.fn(),
      remove: vi.fn(),
      createSyncAccessHandle: vi.fn(),
    },
  }));
  const pipeline = new PhotoPipeline({
    storage: new MemoryStorage(),
    init,
    readTime,
    createWorker: () => worker,
  });
  const running = pipeline.run(scanned, session, time.wallClockMs);
  for (let i = 0; i < files.length; i++) {
    await vi.waitFor(() => expect(worker.requests).toHaveLength(i + 1));
    expect(reads).toBe(Math.min(4 + i, files.length));
    const request = worker.requests[i];
    if (!request) throw new Error('Expected pending photo');
    worker.send(output(request));
  }
  await running;
});

it('reports live progress, remaining time and the actual worker backend', async () => {
  let clock = 0;
  const worker = new TestWorker(() => {});
  const pipeline = new PhotoPipeline({
    storage: new MemoryStorage(),
    init,
    readTime,
    now: () => clock,
    createWorker: () => worker,
  });
  const running = pipeline.run(photos(2), session, time.wallClockMs);
  await vi.waitFor(() => expect(worker.requests).toHaveLength(1));
  expect(pipeline.state.progress.value).toMatchObject({ done: 0, total: 2, secondsLeft: null });
  const first = worker.requests[0];
  if (!first) throw new Error('Expected pending photo');
  clock = 1_000;
  worker.send({ ...output(first), backend: 'webgpu' });
  await vi.waitFor(() => expect(worker.requests).toHaveLength(2));
  expect(pipeline.state.progress.value).toEqual({
    done: 1,
    total: 2,
    photosPerSecond: 1,
    backend: 'webgpu',
    secondsLeft: 1,
  });
  const second = worker.requests[1];
  if (!second) throw new Error('Expected pending photo');
  clock = 2_000;
  worker.send({ ...output(second), backend: 'webgpu' });
  await running;
  expect(pipeline.state.progress.value.secondsLeft).toBe(0);
});

it('retains suspect-clock photos but excludes them from the session date range', async () => {
  const storage = new MemoryStorage();
  const pipeline = new PhotoPipeline({
    storage,
    init,
    readTime: async () => ({ ...time, clockStatus: 'suspect' }),
    createWorker: () => new TestWorker(),
  });
  await pipeline.run(photos(1), session, time.wallClockMs);
  expect(storage.batches.at(-1)?.session.dateRange).toBeNull();
  expect(pipeline.state.progress.value.done).toBe(1);
});

it('surfaces timed persistence failures while a worker request is pending', async () => {
  vi.useFakeTimers();
  const storage = new MemoryStorage();
  const save = storage.saveBatch.bind(storage);
  vi.spyOn(storage, 'saveBatch').mockImplementation(async (batch) => {
    if (batch.results.length) throw new Error('Persistence failed');
    await save(batch);
  });
  const worker = new TestWorker((request, worker) => {
    if (worker.requests.length === 1) worker.send(output(request));
  });
  const pipeline = new PhotoPipeline({ storage, init, readTime, createWorker: () => worker });
  const running = expect(pipeline.run(photos(3), session, time.wallClockMs)).rejects.toThrow(
    'Persistence failed',
  );
  await vi.waitFor(() => expect(worker.requests).toHaveLength(2));
  await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
  await running;
  expect(storage.results.size).toBe(0);
  expect(worker.requests).toHaveLength(2);
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it('processes each sampled frame of a clip and stores the clip as one file-timed result', async () => {
  const storage = new MemoryStorage();
  const worker = new TestWorker();
  const mtimeMs = Date.UTC(2026, 9, 3, 4, 5, 6);
  const [clip] = scanFiles([new File(['mp4'], 'clip.mp4', { lastModified: mtimeMs })]);
  if (!clip) throw new Error('Expected a scanned clip');
  const frames = ['a', 'b', 'c'].map((name) => new File([name], `${name}.png`));
  const clipFrames = vi.fn(async () => ({ status: 'ok' as const, frames }));
  const pipeline = new PhotoPipeline({
    storage,
    init,
    readTime,
    clipFrames,
    createWorker: () => worker,
  });

  await pipeline.run([clip, ...photos(1)], session, time.wallClockMs);

  expect(clipFrames).toHaveBeenCalledOnce();
  expect(worker.requests.map(({ file, settings }) => [file.name, settings.path])).toEqual([
    ['a.png', 'clip.mp4'],
    ['b.png', 'clip.mp4'],
    ['c.png', 'clip.mp4'],
    ['0.jpg', '0.jpg'],
  ]);
  const stored = storage.results.get(fileKey(clip));
  expect(stored?.output).toMatchObject({ path: 'clip.mp4', status: 'ok' });
  expect(stored?.output.status === 'ok' && stored.output.detections).toHaveLength(1);
  expect(stored?.time).toMatchObject({ timeSource: 'file', clockStatus: 'ok' });
  expect(pipeline.state.progress.value).toMatchObject({ done: 2, total: 2 });
});

it('stores only the boxes the classifier labelled', async () => {
  const storage = new MemoryStorage();
  const worker = new TestWorker((request, worker) => {
    const result = output(request);
    if (result.status === 'ok') {
      result.detections.push({ category: '1', conf: 0.05, bbox: [0, 0, 1, 1], label: 'animal' });
    }
    worker.send(result);
  });
  const [file] = photos(1);
  if (!file) throw new Error('Expected a scanned photo');

  await new PhotoPipeline({ storage, init, readTime, createWorker: () => worker }).run(
    [file],
    session,
    time.wallClockMs,
  );

  const stored = storage.results.get(fileKey(file))?.output;
  expect(stored?.status === 'ok' && stored.detections.map(({ conf }) => conf)).toEqual([0.9]);
});

it('stores a clip with an unsupported codec without starting a worker', async () => {
  const storage = new MemoryStorage();
  const createWorker = vi.fn(() => new TestWorker());
  const [clip] = scanFiles([new File(['mp4'], 'clip.mp4', { lastModified: 100 })]);
  if (!clip) throw new Error('Expected a scanned clip');
  const pipeline = new PhotoPipeline({
    storage,
    init,
    readTime,
    createWorker,
    clipFrames: async () => ({ status: 'unsupported_codec', codec: 'hevc' }),
  });

  await pipeline.run([clip], session, time.wallClockMs);

  expect(createWorker).not.toHaveBeenCalled();
  expect(storage.results.get(fileKey(clip))?.output).toMatchObject({
    path: 'clip.mp4',
    status: 'unsupported_codec',
    codec: 'hevc',
  });
  expect(pipeline.state.events.value).toEqual([]);
  expect(pipeline.state.progress.value).toMatchObject({ done: 1, total: 1 });
});
