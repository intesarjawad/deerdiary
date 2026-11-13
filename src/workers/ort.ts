import { observeResources } from '../app/networkMeter';

observeResources((resources) => self.postMessage({ kind: 'network-resources', resources }));

export type SmokeRequest = {
  url: string;
  input: { name: string; shape: number[] };
  backend: 'webgpu' | 'wasm';
  baseUrl: string;
};

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const message = error.stack ?? error.message;
  return error.cause === undefined ? message : `${message}\nCaused by: ${errorText(error.cause)}`;
}

self.addEventListener('error', (event) => {
  self.postMessage({
    error: `${errorText(event.error ?? event.message)} at ${event.filename}:${event.lineno}:${event.colno}`,
    crossOriginIsolated: self.crossOriginIsolated,
  });
});

self.addEventListener('unhandledrejection', (event) => {
  self.postMessage({
    error: errorText(event.reason),
    crossOriginIsolated: self.crossOriginIsolated,
  });
});

self.onmessage = async (event: MessageEvent<SmokeRequest>) => {
  const { url, input, backend, baseUrl } = event.data;
  try {
    // A dynamic import lets the harness report module load and evaluation failures.
    const ort = await import('onnxruntime-web/webgpu');
    ort.env.wasm.wasmPaths = new URL('ort/', baseUrl).href;
    if (backend === 'webgpu' && !navigator.gpu) throw new Error('WebGPU is unavailable');
    const session = await ort.InferenceSession.create(url, {
      executionProviders: backend === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'],
    });
    const tensor = new ort.Tensor(
      'float32',
      new Float32Array(input.shape.reduce((a, b) => a * b, 1)),
      input.shape,
    );
    const times: number[] = [];
    let shapes: Record<string, readonly number[]> = {};
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const output = await session.run({ [input.name]: tensor });
      times.push(performance.now() - start);
      shapes = Object.fromEntries(
        Object.entries(output).map(([name, value]) => [name, value.dims]),
      );
    }
    times.sort((a, b) => a - b);
    await session.release();
    self.postMessage({
      backend,
      medianMs: times[2],
      shapes,
      crossOriginIsolated: self.crossOriginIsolated,
    });
  } catch (error) {
    self.postMessage({
      backend,
      error: errorText(error),
      crossOriginIsolated: self.crossOriginIsolated,
    });
  }
};
