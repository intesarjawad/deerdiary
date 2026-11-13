import type { StoredResult } from '../storage/schema';
import { type Classifications, NUM_CLASSIFICATIONS_FOR_ENSEMBLE } from './labels';

export const MEGADETECTOR_FORMAT_VERSION = '1.6';
export const MEGADETECTOR_DETECTOR = 'MegaDetector v5a.0.1';

export const DETECTION_CATEGORIES: Readonly<Record<string, string>> = {
  '1': 'animal',
  '2': 'person',
  '3': 'vehicle',
};

export type MegaDetectorClassification = {
  name: string;
  conf: number;
};

export type MegaDetectorDetection = {
  category: string;
  conf: number;
  bbox: readonly [x: number, y: number, width: number, height: number];
  classifications: readonly MegaDetectorClassification[];
};

export type MegaDetectorImage = {
  file: string;
  failure?: string;
  detections: readonly MegaDetectorDetection[];
};

export type MegaDetectorBatch = {
  formatVersion: string;
  images: readonly MegaDetectorImage[];
};

export type MegaDetectorExportDetection = {
  category: string;
  conf: number;
  bbox: readonly [x: number, y: number, width: number, height: number];
  raw_classifications?: Classifications;
  processed_classification?: { class: string; score: number; source?: string };
};

export type MegaDetectorExportImage = {
  file: string;
  failure?: string;
  detections: readonly MegaDetectorExportDetection[];
};

export type MegaDetectorExport = {
  images: readonly MegaDetectorExportImage[];
  detector?: string;
  detectionCompletionTime?: string;
  deerdiary?: {
    corrections: Readonly<Record<string, string>>;
    machine_predictions: readonly unknown[];
  };
};

type Result<T> = { ok: true; value: T } | { ok: false; field: string };

export type MegaDetectorParseResult = Result<MegaDetectorBatch>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function isBox(value: unknown): value is readonly [number, number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  );
}

function lookup(categories: Record<string, string>, id: unknown): string | undefined {
  return typeof id === 'string' && Object.hasOwn(categories, id) ? categories[id] : undefined;
}

function parseDetection(
  raw: unknown,
  path: string,
  detectionCategories: Record<string, string>,
  classificationCategories: Record<string, string>,
): Result<MegaDetectorDetection> {
  if (!isRecord(raw)) return { ok: false, field: path };

  const category = lookup(detectionCategories, raw.category);
  if (category === undefined) return { ok: false, field: `${path}.category` };
  if (typeof raw.conf !== 'number' || !Number.isFinite(raw.conf)) {
    return { ok: false, field: `${path}.conf` };
  }
  if (!isBox(raw.bbox)) return { ok: false, field: `${path}.bbox` };

  const classifications: MegaDetectorClassification[] = [];
  if (raw.classifications !== undefined) {
    if (!Array.isArray(raw.classifications)) {
      return { ok: false, field: `${path}.classifications` };
    }
    for (let index = 0; index < raw.classifications.length; index++) {
      const entryPath = `${path}.classifications[${index}]`;
      const entry = raw.classifications[index];
      if (!Array.isArray(entry) || entry.length !== 2) return { ok: false, field: entryPath };
      const [id, conf] = entry;
      const name = lookup(classificationCategories, id);
      if (name === undefined) return { ok: false, field: `${entryPath}[0]` };
      if (typeof conf !== 'number' || !Number.isFinite(conf)) {
        return { ok: false, field: `${entryPath}[1]` };
      }
      classifications.push({ name, conf });
    }
  }

  return {
    ok: true,
    value: { category, conf: raw.conf, bbox: raw.bbox, classifications },
  };
}

function parseImage(
  raw: unknown,
  path: string,
  detectionCategories: Record<string, string>,
  classificationCategories: Record<string, string>,
): Result<MegaDetectorImage> {
  if (!isRecord(raw)) return { ok: false, field: path };
  if (typeof raw.file !== 'string') return { ok: false, field: `${path}.file` };
  if (raw.failure !== undefined && typeof raw.failure !== 'string') {
    return { ok: false, field: `${path}.failure` };
  }

  const detections: MegaDetectorDetection[] = [];
  if (raw.detections !== undefined && raw.detections !== null) {
    if (!Array.isArray(raw.detections)) return { ok: false, field: `${path}.detections` };
    for (let index = 0; index < raw.detections.length; index++) {
      const parsed = parseDetection(
        raw.detections[index],
        `${path}.detections[${index}]`,
        detectionCategories,
        classificationCategories,
      );
      if (!parsed.ok) return parsed;
      detections.push(parsed.value);
    }
  }

  return {
    ok: true,
    value: {
      file: raw.file,
      detections,
      ...(raw.failure === undefined ? {} : { failure: raw.failure }),
    },
  };
}

/**
 * Batch files come from disk rather than the app, so each field is checked before use and the
 * first failing path is reported for an error the user can act on.
 */
export function parseMegaDetector(input: unknown): MegaDetectorParseResult {
  if (!isRecord(input)) return { ok: false, field: 'root' };
  if (!isRecord(input.info)) return { ok: false, field: 'info' };
  if (typeof input.info.format_version !== 'string') {
    return { ok: false, field: 'info.format_version' };
  }
  if (!isStringMap(input.detection_categories)) {
    return { ok: false, field: 'detection_categories' };
  }
  const rawClassificationCategories = input.classification_categories;
  if (rawClassificationCategories !== undefined && !isStringMap(rawClassificationCategories)) {
    return { ok: false, field: 'classification_categories' };
  }
  const classificationCategories = isStringMap(rawClassificationCategories)
    ? rawClassificationCategories
    : {};
  if (!Array.isArray(input.images)) return { ok: false, field: 'images' };

  const images: MegaDetectorImage[] = [];
  for (let index = 0; index < input.images.length; index++) {
    const parsed = parseImage(
      input.images[index],
      `images[${index}]`,
      input.detection_categories,
      classificationCategories,
    );
    if (!parsed.ok) return parsed;
    images.push(parsed.value);
  }

  return { ok: true, value: { formatVersion: input.info.format_version, images } };
}

function commonName(label: string): string {
  return label.split(';').at(-1) || label;
}

function topClasses(
  detection: MegaDetectorExportDetection,
): readonly { class: string; score: number }[] {
  const processed = detection.processed_classification;
  if (processed?.source === 'human') return [processed];
  const raw = detection.raw_classifications;
  if (raw) {
    const count = Math.min(raw.classes.length, raw.scores.length, NUM_CLASSIFICATIONS_FOR_ENSEMBLE);
    const classes: { class: string; score: number }[] = [];
    for (let index = 0; index < count; index++) {
      const label = raw.classes[index];
      const score = raw.scores[index];
      if (label !== undefined && score !== undefined) classes.push({ class: label, score });
    }
    return classes;
  }
  return processed ? [{ class: processed.class, score: processed.score }] : [];
}

/**
 * Writes the batch shape MegaDetector tools read, with numeric classification category IDs
 * because the upstream validator requires them.
 */
export function toMegaDetectorJson(input: MegaDetectorExport): string {
  const labels = [
    ...new Set(
      input.images.flatMap((image) =>
        image.detections.flatMap((detection) => topClasses(detection).map((entry) => entry.class)),
      ),
    ),
  ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const ids = new Map(labels.map((label, index) => [label, String(index + 1)]));
  const classificationCategories = Object.fromEntries(
    labels.map((label, index) => [String(index + 1), commonName(label)]),
  );

  return JSON.stringify(
    {
      info: {
        format_version: MEGADETECTOR_FORMAT_VERSION,
        detector: input.detector ?? MEGADETECTOR_DETECTOR,
        ...(input.detectionCompletionTime === undefined
          ? {}
          : { detection_completion_time: input.detectionCompletionTime }),
      },
      ...(input.deerdiary === undefined ? {} : { deerdiary: input.deerdiary }),
      detection_categories: DETECTION_CATEGORIES,
      classification_categories: classificationCategories,
      images: input.images.map((image) => ({
        file: image.file,
        ...(image.failure === undefined ? {} : { failure: image.failure }),
        detections:
          image.failure === undefined
            ? image.detections.map((detection) => ({
                category: detection.category,
                conf: detection.conf,
                bbox: detection.bbox,
                classifications: topClasses(detection).map((entry) => {
                  const id = ids.get(entry.class);
                  if (id === undefined) {
                    throw new Error(`Missing classification category for ${entry.class}`);
                  }
                  return [id, entry.score];
                }),
              }))
            : null,
      })),
    },
    null,
    2,
  );
}

/**
 * Maps stored photo results to the export shape: an undecodable photo keeps its place in the
 * batch as a failure, so the image count always matches the card.
 */
export function megaDetectorExportFromResults(
  results: readonly StoredResult[],
  detectionCompletionTime?: string,
): MegaDetectorExport {
  return {
    ...(detectionCompletionTime === undefined ? {} : { detectionCompletionTime }),
    images: results.map(({ output }) =>
      output.status === 'ok'
        ? {
            file: output.path,
            detections: output.detections.map((detection) => ({
              category: detection.category,
              conf: detection.conf,
              bbox: detection.bbox,
              ...(detection.raw_classifications === undefined
                ? {}
                : { raw_classifications: detection.raw_classifications }),
              ...(detection.processed_classification === undefined
                ? {}
                : { processed_classification: detection.processed_classification }),
            })),
          }
        : { file: output.path, failure: 'DECODE_FAILED', detections: [] },
    ),
  };
}
