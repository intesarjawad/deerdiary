import { combine } from '../core/ensemble';
import { DEFAULT_INDEPENDENCE_INTERVAL_MIN } from '../core/independence';
import {
  Classification,
  type Classifications,
  type EnsembleContext,
  NUM_CLASSIFICATIONS_FOR_ENSEMBLE,
} from '../core/labels';
import { type MegaDetectorBatch, parseMegaDetector } from '../core/megadetectorJson';
import {
  parseSpeciesNet,
  type SpeciesNetBatch,
  type SpeciesNetEvent,
  type SpeciesNetProcessedClassification,
} from '../core/speciesnetJson';

export type ImportFormat = 'speciesnet' | 'megadetector';

export type ImportedDetection = {
  category: string;
  label: string;
  conf: number;
  bbox: readonly [x: number, y: number, width: number, height: number];
  raw_classifications?: Classifications;
  processed_classification?: SpeciesNetProcessedClassification;
};

export type ImportedPhoto = {
  path: string;
  country?: string;
  failures?: readonly string[];
  detections: readonly ImportedDetection[];
};

export type ImportedBatch = {
  format: ImportFormat;
  photos: readonly ImportedPhoto[];
  events: readonly SpeciesNetEvent[];
  corrections: Readonly<Record<string, string>>;
  independenceIntervalMin: number;
};

export type ImportParseResult = { ok: true; value: ImportedBatch } | { ok: false; field: string };

export const COUNTRY_FIXED_NOTE = 'Country fixed by the imported file';

/** Names the first bad field so the user knows what to fix in the file or which file to pick. */
export function importErrorMessage(field: string): string {
  if (field === 'root') {
    return 'This file is not valid JSON. Pick the predictions file written by SpeciesNet or MegaDetector.';
  }
  return `This file could not be imported: "${field}" is missing or has the wrong type.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function hasProcessedDetection(predictions: readonly unknown[]): boolean {
  for (const image of predictions) {
    if (!isRecord(image) || !Array.isArray(image.detections)) continue;
    for (const detection of image.detections) {
      if (isRecord(detection) && detection.processed_classification !== undefined) return true;
    }
  }
  return false;
}

/** Reads only the keys that distinguish the two supported prediction files. */
export function detectFormat(input: unknown): ImportFormat | undefined {
  if (!isRecord(input) || !isRecord(input.info)) return undefined;
  if (typeof input.info.format_version !== 'string') return undefined;
  if (Array.isArray(input.predictions)) {
    if (
      input.predictions.length === 0 ||
      hasProcessedDetection(input.predictions) ||
      !Array.isArray(input.images)
    ) {
      return 'speciesnet';
    }
  }
  if (Array.isArray(input.images) && isStringMap(input.classification_categories)) {
    return 'megadetector';
  }
  return undefined;
}

const DETECTOR_LABELS: Readonly<Record<string, string>> = {
  '1': 'animal',
  '2': 'human',
  '3': 'vehicle',
  animal: 'animal',
  person: 'human',
  human: 'human',
  vehicle: 'vehicle',
};

const DETECTOR_CLASSES: Readonly<Record<string, string>> = {
  animal: Classification.ANIMAL,
  person: Classification.HUMAN,
  human: Classification.HUMAN,
  vehicle: Classification.VEHICLE,
};

function detectorLabel(category: string): string {
  return DETECTOR_LABELS[category.toLowerCase()] ?? category;
}

function categoryCode(category: string): string {
  if (category === 'animal' || category === '1') return '1';
  if (category === 'person' || category === 'human' || category === '2') return '2';
  if (category === 'vehicle' || category === '3') return '3';
  return category;
}

function megaDetectorClassification(
  category: string,
  conf: number,
): SpeciesNetProcessedClassification | undefined {
  const label = DETECTOR_CLASSES[category.toLowerCase()];
  return label === undefined ? undefined : { class: label, score: conf, source: 'detector' };
}

function speciesNetPhotos(batch: SpeciesNetBatch): ImportedPhoto[] {
  return batch.predictions.map((image) => ({
    path: image.filepath,
    detections: image.detections.map(({ machine_classification, ...detection }) => ({
      ...detection,
      ...(machine_classification === undefined || batch.app === undefined
        ? {}
        : { processed_classification: machine_classification }),
    })),
    ...(image.country === undefined ? {} : { country: image.country }),
    ...(image.failures === undefined ? {} : { failures: image.failures }),
  }));
}

function megaDetectorPhotos(batch: MegaDetectorBatch): ImportedPhoto[] {
  return batch.images.map((image) => ({
    path: image.file,
    detections: image.detections.map((detection) => {
      const raw =
        detection.classifications.length === 0
          ? undefined
          : {
              classes: detection.classifications.map((value) => value.name),
              scores: detection.classifications.map((value) => value.conf),
            };
      const top = detection.classifications[0];
      const processed =
        top === undefined
          ? megaDetectorClassification(detection.category, detection.conf)
          : { class: top.name, score: top.conf, source: 'classifier' as const };
      return {
        category: categoryCode(detection.category),
        label: detectorLabel(detection.category),
        conf: detection.conf,
        bbox: detection.bbox,
        ...(raw === undefined ? {} : { raw_classifications: raw }),
        ...(processed === undefined ? {} : { processed_classification: processed }),
      };
    }),
    ...(image.failure === undefined ? {} : { failures: [image.failure] }),
  }));
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; field: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, field: 'root' };
  }
}

/**
 * Accepts either prediction format at the trust boundary, then returns the photos and any event
 * data in the shape the pipeline consumes.
 */
export function parseImport(input: unknown): ImportParseResult {
  const parsed = typeof input === 'string' ? parseJson(input) : { ok: true as const, value: input };
  if (!parsed.ok) return parsed;
  const format = detectFormat(parsed.value);
  if (format === undefined) {
    if (!isRecord(parsed.value)) return { ok: false, field: 'root' };
    if (!isRecord(parsed.value.info)) return { ok: false, field: 'info' };
    if (typeof parsed.value.info.format_version !== 'string') {
      return { ok: false, field: 'info.format_version' };
    }
    return {
      ok: false,
      field: Array.isArray(parsed.value.images) ? 'classification_categories' : 'predictions',
    };
  }

  if (format === 'speciesnet') {
    const batch = parseSpeciesNet(parsed.value);
    if (!batch.ok) return batch;
    return {
      ok: true,
      value: {
        format,
        photos: speciesNetPhotos(batch.value),
        events: batch.value.app?.events ?? [],
        corrections: batch.value.app?.corrections ?? {},
        independenceIntervalMin:
          batch.value.app?.independenceIntervalMin ?? DEFAULT_INDEPENDENCE_INTERVAL_MIN,
      },
    };
  }

  const batch = parseMegaDetector(parsed.value);
  if (!batch.ok) return batch;
  return {
    ok: true,
    value: {
      format,
      photos: megaDetectorPhotos(batch.value),
      events: [],
      corrections: {},
      independenceIntervalMin: DEFAULT_INDEPENDENCE_INTERVAL_MIN,
    },
  };
}

function pathSegments(path: string): string[] {
  return path.replaceAll('\\', '/').split('/').filter(Boolean);
}

function commonSuffixLength(left: readonly string[], right: readonly string[]): number {
  let length = 0;
  while (
    length < left.length &&
    length < right.length &&
    left[left.length - 1 - length] === right[right.length - 1 - length]
  ) {
    length++;
  }
  return length;
}

/**
 * Prediction files often keep a different folder above the camera card than the dropped folder.
 * The dropped path sharing the longest trailing sequence with the imported path wins.
 */
export function matchPhotoPath(
  importedPath: string,
  photoPaths: readonly string[],
): string | undefined {
  const wanted = pathSegments(importedPath);
  let best: { path: string; shared: number; length: number } | undefined;
  for (const path of photoPaths) {
    const parts = pathSegments(path);
    const shared = commonSuffixLength(wanted, parts);
    if (shared === 0) continue;
    if (
      best === undefined ||
      shared > best.shared ||
      (shared === best.shared && parts.length < best.length)
    ) {
      best = { path, shared, length: parts.length };
    }
  }
  return best?.path;
}

/**
 * The ensemble needs the ranked top five classes. A detection with fewer, or any detection from a
 * MegaDetector-format file whose class names are not SpeciesNet labels, can only keep its label.
 */
function isCountryFixed(format: ImportFormat, detection: ImportedDetection): boolean {
  if (detection.processed_classification === undefined) return false;
  return (
    format === 'megadetector' ||
    detection.raw_classifications === undefined ||
    detection.raw_classifications.classes.length < NUM_CLASSIFICATIONS_FOR_ENSEMBLE
  );
}

/** True when a country change cannot relabel some or all of the imported detections. */
export function hasCountryFixedLabels(batch: ImportedBatch): boolean {
  return (
    batch.format === 'megadetector' ||
    batch.photos.some((photo) =>
      photo.detections.some((detection) => isCountryFixed(batch.format, detection)),
    )
  );
}

/** True when a country change can relabel at least one imported detection. */
export function hasRelabelableDetections(batch: ImportedBatch): boolean {
  return batch.photos.some(
    (photo) =>
      photo.failures === undefined &&
      photo.detections.some(
        (detection) =>
          detection.raw_classifications !== undefined && !isCountryFixed(batch.format, detection),
      ),
  );
}

function recombine(detection: ImportedDetection, context: EnsembleContext): ImportedDetection {
  const raw = detection.raw_classifications;
  if (raw === undefined) return detection;
  try {
    const top = {
      classes: raw.classes.slice(0, NUM_CLASSIFICATIONS_FOR_ENSEMBLE),
      scores: raw.scores.slice(0, NUM_CLASSIFICATIONS_FOR_ENSEMBLE),
    };
    const processed = combine(detection, top, context);
    return { ...detection, processed_classification: processed };
  } catch {
    // Scores outside 0..1 pass the file check; the stored label is better than a failed import.
    return detection;
  }
}

/**
 * Re-applies the geographic ensemble to imported detections that carry all five raw classes and
 * leaves every other detection with the label the file gave it.
 */
export function applyCountry(batch: ImportedBatch, context: EnsembleContext): ImportedBatch {
  return {
    ...batch,
    photos: batch.photos.map((photo) =>
      photo.failures === undefined
        ? {
            ...photo,
            detections: photo.detections.map((detection) =>
              isCountryFixed(batch.format, detection) ? detection : recombine(detection, context),
            ),
          }
        : photo,
    ),
  };
}
