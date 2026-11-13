import {
  PerformanceObserver,
  type PerformanceObserverCallback,
  PerformanceResourceTiming,
} from 'node:perf_hooks';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { SmokeRequest } from '../../src/workers/ort';

const runtime = vi.hoisted(() => {
  const session = {
    run: vi.fn(async () => ({ scores: { dims: [1, 3] } })),
    release: vi.fn(async () => {}),
  };
  return {
    env: { wasm: { wasmPaths: '' } },
    session,
    create: vi.fn(async () => session),
  };
});

vi.mock('onnxruntime-web/webgpu', async (importOriginal) => ({
  ...(await importOriginal<typeof import('onnxruntime-web/webgpu')>()),
  env: runtime.env,
  InferenceSession: { create: runtime.create },
}));

const request = {
  url: 'http://127.0.0.1/model.onnx',
  input: { name: 'images', shape: [1, 3, 2, 2] },
  backend: 'wasm' as const,
  baseUrl: 'http://localhost:4184/',
};

function workerScope() {
  return Object.assign(new EventTarget(), {
    crossOriginIsolated: true,
    postMessage: vi.fn(),
    onmessage: vi.fn<(event: MessageEvent<SmokeRequest>) => Promise<void>>(),
  });
}

let scope = workerScope();
const observers: PerformanceObserver[] = [];

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  scope = workerScope();
  vi.stubGlobal('self', scope);
  vi.stubGlobal(
    'PerformanceObserver',
    class extends PerformanceObserver {
      constructor(callback: PerformanceObserverCallback) {
        super(callback);
        observers.push(this);
      }
    },
  );
  vi.stubGlobal('PerformanceResourceTiming', PerformanceResourceTiming);
});

afterEach(() => {
  for (const observer of observers.splice(0)) observer.disconnect();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('measures five zero-tensor runs and reports the median, shapes and isolation', async () => {
  await import('../../src/workers/ort');
  let elapsedMs = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => elapsedMs);
  for (const durationMs of [9, 1, 7, 3, 5]) {
    runtime.session.run.mockImplementationOnce(async () => {
      elapsedMs += durationMs;
      return { scores: { dims: [1, 3] } };
    });
  }
  await scope.onmessage(new MessageEvent('message', { data: request }));

  expect(runtime.create).toHaveBeenCalledWith(request.url, { executionProviders: ['wasm'] });
  expect(runtime.env.wasm.wasmPaths).toBe('http://localhost:4184/ort/');
  expect(runtime.session.run).toHaveBeenCalledTimes(5);
  expect(runtime.session.run).toHaveBeenCalledWith({
    images: expect.objectContaining({
      dims: request.input.shape,
      data: new Float32Array(12),
    }),
  });
  expect(runtime.session.release).toHaveBeenCalledOnce();
  expect(scope.postMessage).toHaveBeenCalledWith({
    backend: 'wasm',
    medianMs: 5,
    shapes: { scores: [1, 3] },
    crossOriginIsolated: true,
  });
});

test('reports session failures with their error text', async () => {
  runtime.create.mockRejectedValueOnce(new Error('WASM asset could not be fetched'));
  await import('../../src/workers/ort');
  await scope.onmessage(new MessageEvent('message', { data: request }));
  expect(scope.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ error: expect.stringContaining('WASM asset could not be fetched') }),
  );
});

test('requests WebGPU with WASM fallback when WebGPU is available', async () => {
  vi.stubGlobal('navigator', { gpu: {} });
  await import('../../src/workers/ort');
  await scope.onmessage(new MessageEvent('message', { data: { ...request, backend: 'webgpu' } }));
  expect(runtime.create).toHaveBeenCalledWith(request.url, {
    executionProviders: ['webgpu', 'wasm'],
  });
  expect(scope.postMessage).toHaveBeenCalledWith(expect.objectContaining({ backend: 'webgpu' }));
});

test('reports uncaught worker errors with their source location', async () => {
  await import('../../src/workers/ort');
  scope.dispatchEvent(
    Object.assign(new Event('error'), {
      error: new Error('Module evaluation failed'),
      message: '',
      filename: '/ort/runtime.mjs',
      lineno: 12,
      colno: 3,
    }),
  );
  expect(scope.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      error: expect.stringContaining('Module evaluation failed'),
      crossOriginIsolated: true,
    }),
  );
  expect(scope.postMessage.mock.calls[0]?.[0].error).toContain('/ort/runtime.mjs:12:3');
});

test('reports unhandled worker promise rejections', async () => {
  await import('../../src/workers/ort');
  scope.dispatchEvent(
    Object.assign(new Event('unhandledrejection'), {
      reason: new Error('ORT initialization failed'),
    }),
  );
  expect(scope.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ error: expect.stringContaining('ORT initialization failed') }),
  );
});

test('reports ORT module load failures after the worker starts', async () => {
  vi.doMock('onnxruntime-web/webgpu', () => {
    throw new Error('ORT module could not be loaded');
  });
  try {
    await import('../../src/workers/ort');
    await scope.onmessage(new MessageEvent('message', { data: request }));
    expect(scope.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('ORT module could not be loaded') }),
    );
  } finally {
    vi.doUnmock('onnxruntime-web/webgpu');
  }
});
