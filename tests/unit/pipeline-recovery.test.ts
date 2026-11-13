import { expect, it, vi } from 'vitest';
import { PhotoPipeline, RESULT_BATCH_SIZE } from '../../src/app/pipeline';
import { PIPELINE_STOPPED_NOTE, STORAGE_FULL_NOTE } from '../../src/app/state';
import { combine } from '../../src/core/ensemble';
import {
  init,
  MemoryStorage,
  output,
  photos,
  raw,
  readTime,
  session,
  TestWorker,
  time,
} from './fixtures/pipeline';

it('respawns once, retries the same file and ignores late messages from the old worker', async () => {
  const storage = new MemoryStorage();
  const first = new TestWorker((request, worker) => {
    if (worker.requests.length === 2) worker.crash();
    else worker.send(output(request));
  });
  const second = new TestWorker((request, worker) => {
    first.send(output(request));
    worker.send(output(request));
  });
  const createWorker = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
  const pipeline = new PhotoPipeline({ storage, init, readTime, createWorker });
  await pipeline.run(photos(3), session, time.wallClockMs);
  expect(first.requests.map((request) => request.file.name)).toEqual(['0.jpg', '1.jpg']);
  expect(second.requests.map((request) => request.file.name)).toEqual(['1.jpg', '2.jpg']);
  expect(second.initialized).toBe(true);
  expect(pipeline.state.progress.value.done).toBe(3);
  expect(storage.results.size).toBe(3);
});

it('stops on a second crash, saves completed photos and resumes only unfinished files', async () => {
  const storage = new MemoryStorage();
  const first = new TestWorker((request, worker) => {
    if (worker.requests.length === 2) worker.crash();
    else worker.send(output(request));
  });
  const second = new TestWorker((_request, worker) => worker.crash());
  const createWorker = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
  const pipeline = new PhotoPipeline({ storage, init, readTime, createWorker });
  const files = photos(3);
  await expect(pipeline.run(files, session, time.wallClockMs)).rejects.toThrow('Worker crashed');
  expect(createWorker).toHaveBeenCalledTimes(2);
  expect(storage.results.size).toBe(1);
  expect(pipeline.state.failure.value).toEqual({
    message: PIPELINE_STOPPED_NOTE,
    href: 'docs/local-pipeline.md',
  });
  const worker = new TestWorker();
  await new PhotoPipeline({ storage, init, readTime, createWorker: () => worker }).run(
    files,
    session,
    time.wallClockMs,
  );
  expect(worker.requests.map((request) => request.file.name)).toEqual(['1.jpg', '2.jpg']);
});

it('limits respawning across different photos in the same session', async () => {
  const storage = new MemoryStorage();
  const first = new TestWorker((_request, worker) => worker.crash());
  const second = new TestWorker((request, worker) => {
    if (worker.requests.length === 2) worker.crash();
    else worker.send(output(request));
  });
  const createWorker = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
  const pipeline = new PhotoPipeline({ storage, init, readTime, createWorker });
  await expect(pipeline.run(photos(3), session, time.wallClockMs)).rejects.toThrow(
    'Worker crashed',
  );
  expect(createWorker).toHaveBeenCalledTimes(2);
  expect(storage.results.size).toBe(1);
  expect(pipeline.state.failure.value?.message).toBe(PIPELINE_STOPPED_NOTE);
});

it('surfaces inference failures without marking the failed photo complete', async () => {
  const storage = new MemoryStorage();
  const worker = new TestWorker((_request, worker) =>
    worker.send({ status: 'inference_failed', reason: 'Model inference failed' }),
  );
  const createWorker = vi.fn(() => worker);
  const pipeline = new PhotoPipeline({ storage, init, readTime, createWorker });
  await expect(pipeline.run(photos(2), session, time.wallClockMs)).rejects.toThrow(
    'Model inference failed',
  );
  expect(createWorker).toHaveBeenCalledOnce();
  expect(storage.results.size).toBe(0);
  expect(pipeline.state.progress.value.done).toBe(0);
});

it('reruns stored top-five outputs for a country and matches fresh inference exactly', async () => {
  const storage = new MemoryStorage();
  const worker = new TestWorker();
  const pipeline = new PhotoPipeline({ storage, init, readTime, createWorker: () => worker });
  const files = photos(2);
  await pipeline.setLocation({ country: 'USA' });
  await pipeline.run(files, session, time.wallClockMs);
  const before = structuredClone(pipeline.state.results.value);
  await pipeline.setLocation({ country: 'GBR' });
  const freshStorage = new MemoryStorage();
  const fresh = new PhotoPipeline({
    storage: freshStorage,
    init,
    readTime,
    createWorker: () => new TestWorker(),
  });
  await fresh.setLocation({ country: 'GBR' });
  await fresh.run(files, session, time.wallClockMs);
  expect(worker.requests).toHaveLength(2);
  expect(pipeline.state.results.value).toEqual(fresh.state.results.value);
  expect(pipeline.state.events.value).toEqual(fresh.state.events.value);
  const result = pipeline.state.results.value[0];
  if (result?.output.status !== 'ok') throw new Error('Expected successful output');
  expect(result.output.detections[0]?.processed_classification).toEqual(
    combine({ label: 'animal', conf: 0.9 }, raw, { ...init.context, country: 'GBR' }),
  );
  expect(result.output.detections[0]?.processed_classification?.source).toMatch(
    /^classifier\+geofence\+/,
  );
  expect(result.output.detections[0]?.raw_classifications).toEqual(raw);
  expect(pipeline.state.results.value).not.toEqual(before);
  const resumed = new PhotoPipeline({
    storage,
    init,
    readTime,
    createWorker: () => {
      throw new Error('Must not infer');
    },
  });
  await resumed.run(files, session, time.wallClockMs);
  expect(resumed.state.results.value).toEqual(fresh.state.results.value);
});

it('applies a country change to an in-flight result without new inference', async () => {
  const storage = new MemoryStorage();
  const worker = new TestWorker(() => {});
  const pipeline = new PhotoPipeline({ storage, init, readTime, createWorker: () => worker });
  const running = pipeline.run(photos(1), session, time.wallClockMs);
  await vi.waitFor(() => expect(worker.requests).toHaveLength(1));
  await pipeline.setLocation({ country: 'GBR' });
  const request = worker.requests[0];
  if (!request) throw new Error('Expected pending photo');
  worker.send(output(request));
  await running;
  const result = pipeline.state.results.value[0];
  expect(
    result?.output.status === 'ok' && result.output.detections[0]?.processed_classification?.source,
  ).toMatch(/^classifier\+geofence\+/);
});

it('continues in memory after quota exhaustion and counts decode failures as finished', async () => {
  const storage = new MemoryStorage();
  const save = storage.saveBatch.bind(storage);
  vi.spyOn(storage, 'saveBatch').mockImplementation(async (batch) => {
    storage.memoryOnly = true;
    await save(batch);
  });
  const worker = new TestWorker((request, worker) =>
    worker.send({ ...output(request), status: 'decode_failed' }),
  );
  const pipeline = new PhotoPipeline({ storage, init, readTime, createWorker: () => worker });
  await pipeline.run(photos(RESULT_BATCH_SIZE + 1), session, time.wallClockMs);
  expect(pipeline.state.storageNote.value).toBe(STORAGE_FULL_NOTE);
  expect(pipeline.state.progress.value.done).toBe(51);
  expect(pipeline.state.events.value).toEqual([]);
  expect(storage.results.size).toBe(51);
});
