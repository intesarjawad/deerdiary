import { classifierCrop, thumbnailSize } from '../core/crops';
import { combine } from '../core/ensemble';
import type { Classifications, EnsembleContext } from '../core/labels';
import { stretchGeometry } from '../core/letterbox';
import { resizeBilinearPil } from '../core/resize';
import type { Detection } from '../core/types';
import { decodePhoto } from './jpeg';

export const MAX_CROPS_PER_IMAGE = 5;
export const CLASSIFICATION_THRESHOLD = 0.1;
export const CLASSIFIER_SIZE = 480;
export const DETECTOR_SIZE = 640;
const THUMBNAIL_LONG_EDGE = 256;
const CATEGORY_LABELS = { '1': 'animal', '2': 'human', '3': 'vehicle' } as const;

export type Backend = 'webgpu' | 'wasm';
export type PhotoSettings = { path?: string; country?: string; admin1Region?: string };
export type PhotoRequest = {
  file: File;
  settings: PhotoSettings;
  // Serialized CLI boxes isolate classifier parity from detector differences.
  detections?: readonly Detection[];
};
export type ClassifiedDetection = Detection & {
  label: string;
  raw_classifications?: Classifications;
};
export type StageTimes = {
  decode: number;
  preprocess: number;
  detect: number;
  classify: number;
  ensemble: number;
  thumbnail: number;
  total: number;
};
export type PhotoResult = { path: string; backend: Backend; ms: StageTimes } & (
  | { status: 'decode_failed' }
  // A clip whose codec this browser cannot decode; set on the main thread, never by the worker.
  | { status: 'unsupported_codec'; codec: string }
  | {
      status: 'ok';
      width: number;
      height: number;
      detections: ClassifiedDetection[];
      thumbnail: Blob;
      jpegRepaired?: true;
    }
);
export type PhotoModels = {
  backend: Backend;
  detect(input: Float32Array, width: number, height: number): Promise<Detection[]>;
  // A detector with its own preprocessing reads the decoded pixels instead of the shared 640 input.
  detectPixels?(pixels: Uint8Array, width: number, height: number): Promise<Detection[]>;
  classify(input: Uint8Array): Promise<Float32Array>;
};

/** Returns repaired JPEG bytes only when the end marker is missing. */
export function appendMissingJpegEndMarker(bytes: Uint8Array): Uint8Array<ArrayBuffer> | undefined {
  const markerPrefix = 0xff;
  const startOfImage = 0xd8;
  const endOfImage = 0xd9;
  if (bytes[0] !== markerPrefix || bytes[1] !== startOfImage) return undefined;
  if (bytes.at(-2) === markerPrefix && bytes.at(-1) === endOfImage) return undefined;
  const repaired = new Uint8Array(bytes.length + 2);
  repaired.set(bytes);
  repaired.set([markerPrefix, endOfImage], bytes.length);
  return repaired;
}

export function topFive(logits: Float32Array, labels: readonly string[]): Classifications {
  if (logits.length !== labels.length || labels.length < 5 || !logits.every(Number.isFinite))
    throw new Error('Expected finite classifier logits matching at least five labels');
  let maximum = -Infinity;
  for (const value of logits) maximum = Math.max(maximum, value);
  const probabilities = Array.from(logits, (value) => Math.exp(value - maximum));
  const sum = probabilities.reduce((total, value) => total + value, 0);
  const ranked = labels
    .map((label, index) => ({ label, score: (probabilities[index] ?? 0) / sum }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  return {
    classes: ranked.map((value) => value.label),
    scores: ranked.map((value) => value.score),
  };
}

function imageCanvas(width: number, height: number) {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
  if (!context) throw new Error('Could not create a photo canvas');
  return { canvas, context };
}

async function thumbnail(pixels: Uint8Array, width: number, height: number) {
  const size = thumbnailSize(width, height, THUMBNAIL_LONG_EDGE);
  const rgb = resizeBilinearPil(pixels, width, height, size.width, size.height);
  const { canvas, context } = imageCanvas(size.width, size.height);
  const rgba = context.createImageData(size.width, size.height);
  for (let i = 0; i < size.width * size.height; i++) {
    rgba.data[i * 4] = rgb[i * 3] ?? 0;
    rgba.data[i * 4 + 1] = rgb[i * 3 + 1] ?? 0;
    rgba.data[i * 4 + 2] = rgb[i * 3 + 2] ?? 0;
    rgba.data[i * 4 + 3] = 255;
  }
  context.putImageData(rgba, 0, 0);
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
}

/** One serial processor owns reusable model input buffers for its lifetime. */
export class PhotoProcessor {
  private readonly detectorInput = new Float32Array(3 * DETECTOR_SIZE * DETECTOR_SIZE);
  private readonly cropInput = new Uint8Array(3 * CLASSIFIER_SIZE * CLASSIFIER_SIZE);

  constructor(
    private readonly models: PhotoModels,
    private readonly labels: readonly string[],
    private readonly context: EnsembleContext,
  ) {}

  async process({ file, settings, detections: injected }: PhotoRequest): Promise<PhotoResult> {
    const start = performance.now();
    const ms: StageTimes = {
      decode: 0,
      preprocess: 0,
      detect: 0,
      classify: 0,
      ensemble: 0,
      thumbnail: 0,
      total: 0,
    };
    const identity = { path: settings.path ?? file.name, backend: this.models.backend, ms };
    let bitmap: ImageBitmap;
    let jpegRepaired = false;
    try {
      try {
        bitmap = await decodePhoto(file);
      } catch (error) {
        const repaired = appendMissingJpegEndMarker(new Uint8Array(await file.arrayBuffer()));
        if (!repaired) throw error;
        // Appending the end marker recovers truncated JPEGs in Chromium; other engines are unmeasured.
        bitmap = await decodePhoto(new Blob([repaired], { type: 'image/jpeg' }));
        jpegRepaired = true;
      }
    } catch {
      ms.decode = performance.now() - start;
      ms.total = ms.decode;
      return { ...identity, status: 'decode_failed' };
    }
    try {
      const { width, height } = bitmap;
      const { context } = imageCanvas(width, height);
      context.drawImage(bitmap, 0, 0);
      const rgba = context.getImageData(0, 0, width, height).data;
      const pixels = new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
      ms.decode = performance.now() - start;
      let detected: readonly Detection[];
      if (injected) detected = injected;
      else if (this.models.detectPixels) {
        const stage = performance.now();
        detected = await this.models.detectPixels(pixels, width, height);
        ms.detect = performance.now() - stage;
      } else {
        let stage = performance.now();
        const geometry = stretchGeometry(width, height, DETECTOR_SIZE);
        const rgb = resizeBilinearPil(pixels, width, height, geometry.width, geometry.height);
        const plane = DETECTOR_SIZE * DETECTOR_SIZE;
        for (let i = 0; i < plane; i++) {
          for (let c = 0; c < 3; c++)
            this.detectorInput[c * plane + i] = (rgb[i * 3 + c] ?? 0) / 255;
        }
        ms.preprocess = performance.now() - stage;
        stage = performance.now();
        detected = await this.models.detect(this.detectorInput, width, height);
        ms.detect = performance.now() - stage;
      }
      const detections: ClassifiedDetection[] = detected
        .toSorted((a, b) => b.conf - a.conf)
        .map((detection) => ({ ...detection, label: CATEGORY_LABELS[detection.category] }));
      let crops = 0;
      for (const detection of detections) {
        if (detection.conf < CLASSIFICATION_THRESHOLD || crops >= MAX_CROPS_PER_IMAGE) continue;
        let stage = performance.now();
        this.cropInput.set(classifierCrop(pixels, width, height, detection.bbox));
        const raw = topFive(await this.models.classify(this.cropInput), this.labels);
        ms.classify += performance.now() - stage;
        detection.raw_classifications = raw;
        stage = performance.now();
        detection.processed_classification = combine(detection, raw, {
          ...this.context,
          country: settings.country,
          admin1Region: settings.admin1Region,
        });
        ms.ensemble += performance.now() - stage;
        crops++;
      }
      const stage = performance.now();
      const preview = await thumbnail(pixels, width, height);
      ms.thumbnail = performance.now() - stage;
      ms.total = performance.now() - start;
      return {
        ...identity,
        status: 'ok',
        width,
        height,
        detections,
        thumbnail: preview,
        ...(jpegRepaired ? { jpegRepaired: true } : {}),
      };
    } finally {
      bitmap.close();
    }
  }
}
