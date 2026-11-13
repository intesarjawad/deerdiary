import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Classification } from '../../src/core/labels';
import type { InitRequest, WorkerRequest } from '../../src/workers/photo.worker';

const runtime = vi.hoisted(() => ({ create: vi.fn(), release: vi.fn(async () => {}) }));
vi.mock('../../src/workers/photo-ort', () => ({ createPhotoModels: runtime.create }));
function workerScope() {
  return {
    crossOriginIsolated: true,
    postMessage: vi.fn(),
    onmessage: (_event: MessageEvent<WorkerRequest>) => {},
  };
}
let scope = workerScope();
const init: InitRequest = {
  kind: 'init',
  models: { detector: new Uint8Array([1]), classifier: new Uint8Array([2]) },
  labels: Array<string>(2498).fill(Classification.HUMAN),
  context: { taxonomyMap: {}, geofenceMap: {} },
  baseUrl: 'http://localhost/deerdiary/',
  backend: 'wasm',
};
const decode = vi.fn(async (_file: File): Promise<ImageBitmap> => {
  throw new Error('Unreadable photo');
});
const send = (request: WorkerRequest) =>
  scope.onmessage(new MessageEvent('message', { data: request }));

beforeEach(() => {
  vi.resetModules();
  runtime.create.mockReset().mockResolvedValue({ backend: 'wasm', release: runtime.release });
  runtime.release.mockClear();
  decode.mockClear();
  scope = workerScope();
  vi.stubGlobal('self', scope);
  vi.stubGlobal(
    'PerformanceObserver',
    class {
      observe() {}
    },
  );
  vi.stubGlobal('createImageBitmap', decode);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it('initializes before queued photos, reports decode failures and keeps processing', async () => {
  const order: string[] = [];
  let finishInit: (() => void) | undefined;
  runtime.create.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finishInit = resolve;
    });
    order.push('initialized');
    return { backend: 'wasm', release: runtime.release };
  });
  decode.mockImplementation(async (file) => {
    order.push(file.name);
    throw new Error('Unreadable');
  });
  await import('../../src/workers/photo.worker');
  send(init);
  send({ file: new File([], 'first.jpg'), settings: {} });
  send({ file: new File([], 'second.jpg'), settings: {} });
  await vi.waitFor(() => expect(runtime.create).toHaveBeenCalledOnce());
  expect(decode).not.toHaveBeenCalled();
  if (!finishInit) throw new Error('Initialization did not start');
  finishInit();
  await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(2));
  expect(order).toEqual(['initialized', 'first.jpg', 'second.jpg']);
  expect(scope.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ status: 'decode_failed', path: 'first.jpg' }),
  );
  expect(scope.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ status: 'decode_failed', path: 'second.jpg' }),
  );
});

it('reports initialization failures and releases sessions before reinitializing', async () => {
  runtime.create.mockRejectedValueOnce(new Error('Model failed'));
  await import('../../src/workers/photo.worker');
  send(init);
  await vi.waitFor(() =>
    expect(scope.postMessage).toHaveBeenCalledWith({
      status: 'inference_failed',
      reason: 'Model failed',
    }),
  );
  send(init);
  await vi.waitFor(() => expect(runtime.create).toHaveBeenCalledTimes(2));
  send(init);
  await vi.waitFor(() => expect(runtime.create).toHaveBeenCalledTimes(3));
  expect(runtime.release).toHaveBeenCalledOnce();
});

it('reports missing initialization and invalid label metadata without killing the queue', async () => {
  await import('../../src/workers/photo.worker');
  send({ file: new File([], 'before.jpg'), settings: {} });
  send({ ...init, labels: ['invalid'] });
  send({ kind: 'echo', value: 'still listening' });
  await vi.waitFor(() =>
    expect(scope.postMessage).toHaveBeenCalledWith({ kind: 'echo', value: 'still listening' }),
  );
  expect(scope.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      status: 'inference_failed',
      path: 'before.jpg',
      reason: expect.stringContaining('Initialize'),
    }),
  );
  expect(scope.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      status: 'inference_failed',
      reason: expect.stringContaining('2498'),
    }),
  );
  expect(runtime.create).not.toHaveBeenCalled();
});

it('passes the requested detector kind to the model factory', async () => {
  await import('../../src/workers/photo.worker');
  send({ ...init, detector: 'reference' });
  await vi.waitFor(() => expect(runtime.create).toHaveBeenCalledOnce());
  expect(runtime.create).toHaveBeenCalledWith(init.models, init.baseUrl, init.backend, 'reference');
  send(init);
  await vi.waitFor(() => expect(runtime.create).toHaveBeenCalledTimes(2));
  expect(runtime.create).toHaveBeenLastCalledWith(
    init.models,
    init.baseUrl,
    init.backend,
    undefined,
  );
});
