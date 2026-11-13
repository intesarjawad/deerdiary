import type * as Ort from 'onnxruntime-web/webgpu';
import { observeResources, type ResourceMessage } from '../app/networkMeter';
import { AUDIO_SAMPLE_RATE, AUDIO_WINDOW_SAMPLES } from '../core/audioWindows';
import { type AudioCard, analyseAudio } from '../files/audio';
import type { Backend } from './photo';

export const PERCH_LABEL_COUNT = 14_795;

export type InitRequest = {
  kind: 'init';
  model: Uint8Array;
  labels: readonly string[];
  baseUrl: string;
  backend: Backend;
};
export type AudioRequest = { kind: 'audio'; path: string; samples: Float32Array };
export type WorkerRequest = InitRequest | AudioRequest | { kind: 'echo'; value: string };
export type AudioResult = {
  kind: 'audio';
  path: string;
  backend: Backend;
  windowCount: number;
  audioSeconds: number;
  ms: number;
  cards: AudioCard[];
};
export type WorkerResponse =
  | AudioResult
  | ResourceMessage
  | { kind: 'ready' | 'initialized'; backend: Backend; crossOriginIsolated: boolean }
  | { kind: 'echo'; value: string }
  | { kind: 'inference_failed'; path?: string; reason: string };

observeResources((resources) => self.postMessage({ kind: 'network-resources', resources }));
self.postMessage({ kind: 'ready', backend: 'wasm', crossOriginIsolated: self.crossOriginIsolated });

type Perch = {
  backend: Backend;
  session: Ort.InferenceSession;
  ort: typeof Ort;
  labels: readonly string[];
};
let perch: Perch | undefined;
let queue = Promise.resolve();

async function createPerch(request: InitRequest): Promise<Perch> {
  const ort = await import('onnxruntime-web/webgpu');
  ort.env.wasm.wasmPaths = new URL('ort/', request.baseUrl).href;
  ort.env.wasm.numThreads = globalThis.crossOriginIsolated
    ? Math.min(navigator.hardwareConcurrency || 1, 8)
    : 1;
  ort.env.wasm.proxy = false;
  const open = (provider: Backend) =>
    ort.InferenceSession.create(request.model, {
      executionProviders: provider === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'],
    });
  let backend = request.backend;
  const session = await open(backend).catch((error: unknown) => {
    if (backend !== 'webgpu') throw error;
    backend = 'wasm';
    return open('wasm');
  });
  return { backend, session, ort, labels: request.labels };
}

async function infer({ ort, session }: Perch, window: Float32Array): Promise<Float32Array> {
  const input = new ort.Tensor('float32', window, [1, AUDIO_WINDOW_SAMPLES]);
  let output: Ort.InferenceSession.ReturnType = {};
  try {
    output = await session.run({ inputs: input }, ['label']);
    const label = output.label;
    if (
      !label ||
      !(label.data instanceof Float32Array) ||
      label.dims.join() !== `1,${PERCH_LABEL_COUNT}`
    )
      throw new Error('Invalid Perch label output tensor');
    return label.data.slice();
  } finally {
    input.dispose();
    for (const tensor of Object.values(output)) tensor.dispose();
  }
}

async function receive(request: WorkerRequest) {
  switch (request.kind) {
    case 'echo':
      self.postMessage(request);
      return;
    case 'init': {
      if (request.labels.length !== PERCH_LABEL_COUNT)
        throw new Error(`Expected ${PERCH_LABEL_COUNT} Perch labels in model output order`);
      const previous = perch;
      perch = undefined;
      await previous?.session.release();
      perch = await createPerch(request);
      self.postMessage({
        kind: 'initialized',
        backend: perch.backend,
        crossOriginIsolated: self.crossOriginIsolated,
      });
      return;
    }
    case 'audio': {
      if (!perch) throw new Error('Initialize Perch before sending audio');
      const model = perch;
      const start = performance.now();
      const { windowCount, cards } = await analyseAudio(request.samples, model.labels, (window) =>
        infer(model, window),
      );
      const result: AudioResult = {
        kind: 'audio',
        path: request.path,
        backend: model.backend,
        windowCount,
        audioSeconds: request.samples.length / AUDIO_SAMPLE_RATE,
        ms: performance.now() - start,
        cards,
      };
      self.postMessage(
        result,
        cards.map((card) => card.wav.buffer),
      );
      return;
    }
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  queue = queue
    .then(() => receive(event.data))
    .catch((error: unknown) => {
      self.postMessage({
        kind: 'inference_failed',
        ...(event.data.kind === 'audio' ? { path: event.data.path } : {}),
        reason: error instanceof Error ? error.message : String(error),
      });
    });
};
