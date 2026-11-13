import { Tensor } from 'onnxruntime-web/webgpu';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPhotoModels } from '../../src/workers/photo-ort';

const runtime = vi.hoisted(() => ({
  env: { wasm: { wasmPaths: '', numThreads: 0, proxy: true } },
  create: vi.fn<typeof import('onnxruntime-web/webgpu').InferenceSession.create>(),
}));
vi.mock('onnxruntime-web/webgpu', async (importOriginal) => ({
  ...(await importOriginal<typeof import('onnxruntime-web/webgpu')>()),
  env: runtime.env,
  InferenceSession: { create: runtime.create },
}));

const bytes = { detector: new Uint8Array([1]), classifier: new Uint8Array([2]) };
const baseUrl = 'http://localhost/deerdiary/';
function sessions() {
  const detector = {
    run: vi.fn(async (_feeds: Record<string, Tensor>) => {
      const labels = new BigInt64Array(300);
      const boxes = new Float32Array(1200);
      const scores = new Float32Array(300);
      boxes.set([100, 200, 300, 400, 100, 200, 300, 400]);
      scores.set([0.9, 0.8]);
      return {
        labels: new Tensor('int64', labels, [1, 300]),
        boxes: new Tensor('float32', boxes, [1, 300, 4]),
        scores: new Tensor('float32', scores, [1, 300]),
      };
    }),
    release: vi.fn(async () => {}),
    inputNames: ['images', 'orig_target_sizes'],
    outputNames: ['labels', 'boxes', 'scores'],
    inputMetadata: [],
    outputMetadata: [],
    startProfiling: vi.fn(),
    endProfiling: vi.fn(),
  };
  const classifier = {
    ...detector,
    run: vi.fn(async (_feeds: Record<string, Tensor>) => ({
      logits: new Tensor('float32', new Float32Array(2498).fill(3), [1, 2498]),
    })),
    release: vi.fn(async () => {}),
  };
  runtime.create.mockResolvedValueOnce(detector).mockResolvedValueOnce(classifier);
  return { detector, classifier };
}
beforeEach(() => {
  runtime.create.mockReset();
  vi.stubGlobal('navigator', { hardwareConcurrency: 16 });
  vi.stubGlobal('crossOriginIsolated', true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('uses local ORT assets, bounded isolated threads and original width/height in int64', async () => {
  const { detector, classifier } = sessions();
  const models = await createPhotoModels(bytes, baseUrl, 'wasm');
  expect(runtime.env.wasm).toEqual({
    wasmPaths: 'http://localhost/deerdiary/ort/',
    numThreads: 8,
    proxy: false,
  });
  expect(runtime.create).toHaveBeenNthCalledWith(1, bytes.detector, {
    executionProviders: ['wasm'],
  });
  expect(runtime.create).toHaveBeenNthCalledWith(2, bytes.classifier, {
    executionProviders: ['wasm'],
  });
  let captured: BigInt64Array | undefined;
  detector.run.mockImplementationOnce(async (feeds) => {
    const size = feeds.orig_target_sizes;
    if (!(size?.data instanceof BigInt64Array)) throw new Error('Missing int64 dimensions');
    captured = size.data.slice();
    expect(feeds.images?.dims).toEqual([1, 3, 640, 640]);
    return {
      labels: new Tensor('int64', new BigInt64Array(300), [1, 300]),
      boxes: new Tensor('float32', new Float32Array(1200), [1, 300, 4]),
      scores: new Tensor('float32', new Float32Array(300), [1, 300]),
    };
  });
  expect(await models.detect(new Float32Array(3 * 640 * 640), 4000, 3000)).toEqual([]);
  expect(captured).toEqual(new BigInt64Array([4000n, 3000n]));
  // Deployment top-k has already run; overlapping detections must both survive.
  const detected = await models.detect(new Float32Array(3 * 640 * 640), 4000, 3000);
  expect(detected).toHaveLength(2);
  expect(detected[0]?.bbox).toEqual([0.025, 200 / 3000, 0.05, 200 / 3000]);
  await models.release();
  expect(detector.release).toHaveBeenCalledOnce();
  expect(classifier.release).toHaveBeenCalledOnce();
});

it('normalizes quantized RGB NHWC and copies logits before disposing tensors', async () => {
  const { classifier } = sessions();
  const models = await createPhotoModels(bytes, baseUrl, 'wasm');
  const logits = new Tensor('float32', new Float32Array(2498).fill(7), [1, 2498]);
  const dispose = vi.spyOn(logits, 'dispose');
  classifier.run.mockImplementationOnce(async (feeds) => {
    expect(feeds.image?.dims).toEqual([1, 480, 480, 3]);
    expect(feeds.image?.data.slice(0, 3)).toEqual(new Float32Array([1, 128 / 255, 0]));
    return { logits };
  });
  const input = new Uint8Array(480 * 480 * 3);
  input.set([255, 128, 0]);
  const result = await models.classify(input);
  expect(result).toEqual(new Float32Array(2498).fill(7));
  expect(dispose).toHaveBeenCalledOnce();
  await models.release();
});

it('releases a partial GPU initialization before retrying both sessions on WASM', async () => {
  const partial = sessions();
  runtime.create
    .mockReset()
    .mockResolvedValueOnce(partial.detector)
    .mockRejectedValueOnce(new Error('GPU classifier unavailable'));
  const fallback = sessions();
  const models = await createPhotoModels(bytes, baseUrl, 'webgpu');
  expect(models.backend).toBe('wasm');
  expect(partial.detector.release).toHaveBeenCalledOnce();
  expect(runtime.create).toHaveBeenNthCalledWith(1, bytes.detector, {
    executionProviders: ['webgpu', 'wasm'],
  });
  expect(runtime.create).toHaveBeenNthCalledWith(3, bytes.detector, {
    executionProviders: ['wasm'],
  });
  await models.release();
  expect(fallback.classifier.release).toHaveBeenCalledOnce();
});

it('uses one WASM thread without isolation and propagates CPU initialization failures', async () => {
  vi.stubGlobal('crossOriginIsolated', false);
  runtime.create.mockRejectedValueOnce(new Error('Invalid model'));
  await expect(createPhotoModels(bytes, baseUrl, 'wasm')).rejects.toThrow('Invalid model');
  expect(runtime.env.wasm.numThreads).toBe(1);
  expect(runtime.create).toHaveBeenCalledOnce();
});

it('disposes detector and classifier tensors when output validation fails', async () => {
  const { detector, classifier } = sessions();
  const models = await createPhotoModels(bytes, baseUrl, 'wasm');
  const bad = new Tensor('float32', new Float32Array(5), [1, 5]);
  const dispose = vi.spyOn(bad, 'dispose');
  classifier.run.mockResolvedValueOnce({ logits: bad });
  await expect(models.classify(new Uint8Array(480 * 480 * 3))).rejects.toThrow('Invalid logits');
  expect(dispose).toHaveBeenCalledOnce();
  detector.run.mockRejectedValueOnce(new Error('Execution failed'));
  const tensorDispose = vi.spyOn(Tensor.prototype, 'dispose');
  await expect(models.detect(new Float32Array(3 * 640 * 640), 4, 2)).rejects.toThrow(
    'Execution failed',
  );
  expect(tensorDispose).toHaveBeenCalledTimes(2);
  await models.release();
});

function referenceDetector(shape: (number | string)[], rows: number[][]) {
  const flat = new Float32Array(rows.length * 8);
  for (const [index, row] of rows.entries()) flat.set(row, index * 8);
  const run = vi.fn(async (_feeds: Record<string, Tensor>) => ({
    output: new Tensor('float32', flat, [1, rows.length, 8]),
  }));
  const detector = {
    run,
    release: vi.fn(async () => {}),
    inputMetadata: [{ name: 'images', isTensor: true, type: 'float32', shape }],
  };
  const classifier = { run: vi.fn(), release: vi.fn(async () => {}), inputMetadata: [] };
  runtime.create
    .mockResolvedValueOnce(detector as never)
    .mockResolvedValueOnce(classifier as never);
  return detector;
}

it('letterboxes to the minimum stride rectangle when the reference export is dynamic', async () => {
  const detector = referenceDetector(
    ['batch', 3, 'height', 'width'],
    [[640, 480, 200, 100, 0.9, 0.8, 0.1, 0]],
  );
  const models = await createPhotoModels(bytes, baseUrl, 'wasm', 'reference');
  const detected = await models.detectPixels?.(new Uint8Array(400 * 300 * 4), 400, 300);
  expect(detector.run.mock.calls[0]?.[0].images?.dims).toEqual([1, 3, 960, 1280]);
  expect(detected).toHaveLength(1);
  expect(detected?.[0]?.category).toBe('1');
  expect(detected?.[0]?.conf).toBeCloseTo(0.72);
  expect(detected?.[0]?.bbox[0]).toBeCloseTo(169 / 400);
  expect(detected?.[0]?.bbox[1]).toBeCloseTo(134 / 300);
  expect(detected?.[0]?.bbox[2]).toBeCloseTo(62 / 400);
  expect(detected?.[0]?.bbox[3]).toBeCloseTo(32 / 300);
  await expect(models.detect(new Float32Array(0), 400, 300)).rejects.toThrow('decoded photo');
  await models.release();
});

it('pads to the fixed 1280 square when the reference export has a fixed input', async () => {
  const detector = referenceDetector([1, 3, 1280, 1280], [[640, 640, 200, 100, 0.9, 0.8, 0.1, 0]]);
  const models = await createPhotoModels(bytes, baseUrl, 'wasm', 'reference');
  const detected = await models.detectPixels?.(new Uint8Array(400 * 300 * 4), 400, 300);
  expect(detector.run.mock.calls[0]?.[0].images?.dims).toEqual([1, 3, 1280, 1280]);
  expect(detected?.[0]?.bbox[1]).toBeCloseTo(134 / 300);
  await models.release();
});

it('rejects malformed reference output and disposes its tensors', async () => {
  const detector = referenceDetector([1, 3, 1280, 1280], []);
  const models = await createPhotoModels(bytes, baseUrl, 'wasm', 'reference');
  const bad = new Tensor('float32', new Float32Array(6), [1, 6]);
  const dispose = vi.spyOn(bad, 'dispose');
  detector.run.mockResolvedValueOnce({ output: bad });
  await expect(models.detectPixels?.(new Uint8Array(4 * 4 * 4), 4, 4)).rejects.toThrow(
    'reference detector',
  );
  expect(dispose).toHaveBeenCalledOnce();
  await models.release();
});

it('leaves the default detector without a pixel path', async () => {
  sessions();
  const models = await createPhotoModels(bytes, baseUrl, 'wasm');
  expect(models.detectPixels).toBeUndefined();
  await models.release();
});
