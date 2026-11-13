import * as ort from 'onnxruntime-web/webgpu';
import { decodeRtdetr, decodeYolov5 } from '../core/detections';
import { letterboxGeometry, letterboxInput } from '../core/letterbox';
import { type Backend, CLASSIFIER_SIZE, DETECTOR_SIZE, type PhotoModels } from './photo';

export type ModelBytes = { detector: Uint8Array; classifier: Uint8Array };
export type DetectorKind = 'default' | 'reference';

const REFERENCE_SIZE = 1280;
const REFERENCE_STRIDE = 64;

function floatOutput(output: ort.InferenceSession.ReturnType, name: string, dims: number[]) {
  const tensor = output[name];
  if (!tensor || !(tensor.data instanceof Float32Array) || tensor.dims.join() !== dims.join())
    throw new Error(`Invalid ${name} output tensor`);
  return tensor.data;
}

/** Model bytes have already passed the model cache integrity check. */
export async function createPhotoModels(
  bytes: ModelBytes,
  baseUrl: string,
  requested: Backend,
  detectorKind: DetectorKind = 'default',
): Promise<PhotoModels & { release(): Promise<void> }> {
  ort.env.wasm.wasmPaths = new URL('ort/', baseUrl).href;
  ort.env.wasm.numThreads = globalThis.crossOriginIsolated
    ? Math.min(navigator.hardwareConcurrency || 1, 8)
    : 1;
  ort.env.wasm.proxy = false;
  let backend = requested;
  async function sessions(provider: Backend) {
    const options = { executionProviders: provider === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'] };
    const detector = await ort.InferenceSession.create(bytes.detector, options);
    try {
      const classifier = await ort.InferenceSession.create(bytes.classifier, options);
      return { detector, classifier };
    } catch (error) {
      await detector.release();
      throw error;
    }
  }
  const loaded = await sessions(requested).catch((error: unknown) => {
    if (requested !== 'webgpu') throw error;
    backend = 'wasm';
    return sessions('wasm');
  });
  const classifierInput = new Float32Array(CLASSIFIER_SIZE * CLASSIFIER_SIZE * 3);
  const inputShape = loaded.detector.inputMetadata[0];
  // The fixed 1280 square export cannot take the minimum-padding rectangle the official pipeline uses.
  const dynamicInput = inputShape?.isTensor === true && typeof inputShape.shape[2] === 'string';
  return {
    backend,
    async detect(input, width, height) {
      if (detectorKind === 'reference')
        throw new Error('Reference mode detects from decoded photo pixels');
      const image = new ort.Tensor('float32', input, [1, 3, DETECTOR_SIZE, DETECTOR_SIZE]);
      const size = new ort.Tensor(
        'int64',
        new BigInt64Array([BigInt(width), BigInt(height)]),
        [1, 2],
      );
      let output: ort.InferenceSession.ReturnType = {};
      try {
        output = await loaded.detector.run({ images: image, orig_target_sizes: size });
        const labels = output.labels;
        if (!labels || !(labels.data instanceof BigInt64Array) || labels.dims.join() !== '1,300')
          throw new Error('Invalid RT-DETR labels output tensor');
        return decodeRtdetr(
          labels.data,
          floatOutput(output, 'boxes', [1, 300, 4]),
          floatOutput(output, 'scores', [1, 300]),
          width,
          height,
        );
      } finally {
        image.dispose();
        size.dispose();
        for (const tensor of Object.values(output)) tensor.dispose();
      }
    },
    ...(detectorKind === 'reference'
      ? {
          async detectPixels(pixels: Uint8Array, width: number, height: number) {
            const geometry = letterboxGeometry(
              width,
              height,
              REFERENCE_SIZE,
              REFERENCE_STRIDE,
              dynamicInput,
            );
            const image = new ort.Tensor('float32', letterboxInput(pixels, geometry), [
              1,
              3,
              geometry.height,
              geometry.width,
            ]);
            let output: ort.InferenceSession.ReturnType = {};
            try {
              output = await loaded.detector.run({ images: image });
              const rows = output.output;
              if (
                !rows ||
                !(rows.data instanceof Float32Array) ||
                rows.dims.length !== 3 ||
                rows.dims[0] !== 1 ||
                rows.dims[2] !== 8
              )
                throw new Error('Invalid output tensor from the reference detector');
              return decodeYolov5(rows.data, geometry);
            } finally {
              image.dispose();
              for (const tensor of Object.values(output)) tensor.dispose();
            }
          },
        }
      : {}),
    async classify(input) {
      for (let i = 0; i < input.length; i++) classifierInput[i] = (input[i] ?? 0) / 255;
      const image = new ort.Tensor('float32', classifierInput, [
        1,
        CLASSIFIER_SIZE,
        CLASSIFIER_SIZE,
        3,
      ]);
      let output: ort.InferenceSession.ReturnType = {};
      try {
        output = await loaded.classifier.run({ image });
        return floatOutput(output, 'logits', [1, 2498]).slice();
      } finally {
        image.dispose();
        for (const tensor of Object.values(output)) tensor.dispose();
      }
    },
    async release() {
      await Promise.all([loaded.detector.release(), loaded.classifier.release()]);
    },
  };
}
