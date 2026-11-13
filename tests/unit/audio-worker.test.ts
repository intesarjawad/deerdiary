import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { InitRequest, WorkerRequest } from '../../src/workers/audio.worker';

const LABEL_COUNT = 14_795;
const runtime = vi.hoisted(() => ({
  env: { wasm: { wasmPaths: '', numThreads: 0, proxy: true } },
  create: vi.fn(),
  release: vi.fn(async () => {}),
}));
vi.mock('onnxruntime-web/webgpu', () => ({
  env: runtime.env,
  InferenceSession: { create: runtime.create },
  Tensor: class {
    constructor(
      readonly type: string,
      readonly data: Float32Array,
      readonly dims: number[],
    ) {}
    dispose() {}
  },
}));

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
  model: new Uint8Array([1]),
  labels: Array.from({ length: LABEL_COUNT }, (_, index) => `label ${index}`),
  baseUrl: 'http://localhost/deerdiary/',
  backend: 'wasm',
};
const send = (request: WorkerRequest) =>
  scope.onmessage(new MessageEvent('message', { data: request }));
const session = () => ({
  run: vi.fn(async () => {
    const logits = new Float32Array(LABEL_COUNT);
    logits[7] = 10;
    return { label: { data: logits, dims: [1, LABEL_COUNT], dispose() {} } };
  }),
  release: runtime.release,
});

beforeEach(() => {
  vi.resetModules();
  runtime.create.mockReset().mockImplementation(async () => session());
  runtime.release.mockClear();
  scope = workerScope();
  vi.stubGlobal('self', scope);
  vi.stubGlobal(
    'PerformanceObserver',
    class {
      observe() {}
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it('scores ten seconds of audio in two windows and posts the card with its clip', async () => {
  await import('../../src/workers/audio.worker');
  send(init);
  send({ kind: 'audio', path: 'night/20260314_053000.WAV', samples: new Float32Array(320_000) });
  await vi.waitFor(() =>
    expect(scope.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'audio', path: 'night/20260314_053000.WAV' }),
      expect.any(Array),
    ),
  );
  expect(scope.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'initialized', backend: 'wasm' }),
  );
  const [result, transfer] = scope.postMessage.mock.calls.at(-1) ?? [];
  expect(result).toMatchObject({
    backend: 'wasm',
    windowCount: 2,
    audioSeconds: 10,
    cards: [{ label: 'label 7', windows: 2, bestWindow: 0 }],
  });
  expect(transfer).toEqual([result.cards[0].wav.buffer]);
  expect(runtime.env.wasm.wasmPaths).toBe('http://localhost/deerdiary/ort/');
  expect(runtime.env.wasm.proxy).toBe(false);
});

it('asks the session for the label output only', async () => {
  await import('../../src/workers/audio.worker');
  send(init);
  send({ kind: 'audio', path: 'a.wav', samples: new Float32Array(160_000) });
  await vi.waitFor(() => expect(runtime.create).toHaveBeenCalledOnce());
  const created = await runtime.create.mock.results[0]?.value;
  await vi.waitFor(() => expect(created.run).toHaveBeenCalledOnce());
  const [feeds, fetches] = created.run.mock.calls[0];
  expect(Object.keys(feeds)).toEqual(['inputs']);
  expect(feeds.inputs.dims).toEqual([1, 160_000]);
  expect(fetches).toEqual(['label']);
});

it('falls back to WASM when the WebGPU session cannot be created', async () => {
  runtime.create.mockRejectedValueOnce(new Error('No adapter'));
  await import('../../src/workers/audio.worker');
  send({ ...init, backend: 'webgpu' });
  await vi.waitFor(() =>
    expect(scope.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'initialized', backend: 'wasm' }),
    ),
  );
  expect(runtime.create).toHaveBeenCalledTimes(2);
});

it('reports audio before initialization and a wrong label count, and keeps listening', async () => {
  await import('../../src/workers/audio.worker');
  send({ kind: 'audio', path: 'early.wav', samples: new Float32Array(160_000) });
  send({ ...init, labels: ['one'] });
  send({ kind: 'echo', value: 'still listening' });
  await vi.waitFor(() =>
    expect(scope.postMessage).toHaveBeenCalledWith({ kind: 'echo', value: 'still listening' }),
  );
  expect(scope.postMessage).toHaveBeenCalledWith({
    kind: 'inference_failed',
    path: 'early.wav',
    reason: 'Initialize Perch before sending audio',
  });
  expect(scope.postMessage).toHaveBeenCalledWith({
    kind: 'inference_failed',
    reason: `Expected ${LABEL_COUNT} Perch labels in model output order`,
  });
  expect(runtime.create).not.toHaveBeenCalled();
});

it('rejects an output tensor of the wrong shape', async () => {
  runtime.create.mockImplementation(async () => ({
    run: async () => ({ label: { data: new Float32Array(3), dims: [1, 3], dispose() {} } }),
    release: runtime.release,
  }));
  await import('../../src/workers/audio.worker');
  send(init);
  send({ kind: 'audio', path: 'a.wav', samples: new Float32Array(160_000) });
  await vi.waitFor(() =>
    expect(scope.postMessage).toHaveBeenCalledWith({
      kind: 'inference_failed',
      path: 'a.wav',
      reason: 'Invalid Perch label output tensor',
    }),
  );
});

it('releases the previous session before reinitializing', async () => {
  await import('../../src/workers/audio.worker');
  send(init);
  send(init);
  await vi.waitFor(() => expect(runtime.create).toHaveBeenCalledTimes(2));
  expect(runtime.release).toHaveBeenCalledOnce();
});
