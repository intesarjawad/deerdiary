import { type Classifications, NUM_CLASSIFICATIONS_FOR_ENSEMBLE } from './labels';

export const SPECIESNET_FORMAT_VERSION = '20261015';
export const EXPORT_VERSION = 1;

/** The stored pipeline keeps a plain source string, so imported files may contain the same. */
export type SpeciesNetProcessedClassification = {
  class: string;
  score: number;
  source: string;
};

export type SpeciesNetDetection = {
  category: string;
  label: string;
  conf: number;
  bbox: readonly [x: number, y: number, width: number, height: number];
  raw_classifications?: Classifications;
  processed_classification?: SpeciesNetProcessedClassification;
  machine_classification?: SpeciesNetProcessedClassification;
};

export type SpeciesNetImage = {
  filepath: string;
  country?: string;
  failures?: readonly string[];
  detections: readonly SpeciesNetDetection[];
};

export type SpeciesNetEvent = {
  id: string;
  camera: string;
  photos: readonly string[];
  species: readonly string[];
};

export type SpeciesNetAppBlock = {
  version: number;
  events: readonly SpeciesNetEvent[];
  corrections: Readonly<Record<string, string>>;
  independenceIntervalMin: number;
};

export type SpeciesNetBatch = {
  formatVersion: string;
  predictions: readonly SpeciesNetImage[];
  app?: SpeciesNetAppBlock;
};

export type SpeciesNetExport = {
  predictions: readonly SpeciesNetImage[];
  events: readonly SpeciesNetEvent[];
  corrections: Readonly<Record<string, string>>;
  independenceIntervalMin: number;
};

type Result<T> = { ok: true; value: T } | { ok: false; field: string };

export type SpeciesNetParseResult = Result<SpeciesNetBatch>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
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

function isClassifications(value: unknown): value is Classifications {
  if (!isRecord(value) || !isStringArray(value.classes) || !Array.isArray(value.scores)) {
    return false;
  }
  return (
    value.classes.length === value.scores.length &&
    value.scores.every((entry) => isFiniteNumber(entry))
  );
}

function isProcessed(value: unknown): value is SpeciesNetProcessedClassification {
  return (
    isRecord(value) &&
    typeof value.class === 'string' &&
    isFiniteNumber(value.score) &&
    typeof value.source === 'string'
  );
}

function parseDetection(raw: unknown, path: string): Result<SpeciesNetDetection> {
  if (!isRecord(raw)) return { ok: false, field: path };
  if (typeof raw.category !== 'string') return { ok: false, field: `${path}.category` };
  if (typeof raw.label !== 'string') return { ok: false, field: `${path}.label` };
  if (!isFiniteNumber(raw.conf)) return { ok: false, field: `${path}.conf` };
  if (!isBox(raw.bbox)) return { ok: false, field: `${path}.bbox` };
  if (raw.raw_classifications !== undefined && !isClassifications(raw.raw_classifications)) {
    return { ok: false, field: `${path}.raw_classifications` };
  }
  if (raw.processed_classification !== undefined && !isProcessed(raw.processed_classification)) {
    return { ok: false, field: `${path}.processed_classification` };
  }
  if (raw.machine_classification !== undefined && !isProcessed(raw.machine_classification)) {
    return { ok: false, field: `${path}.machine_classification` };
  }
  return {
    ok: true,
    value: {
      ...(raw.machine_classification === undefined
        ? {}
        : { machine_classification: raw.machine_classification }),
      category: raw.category,
      label: raw.label,
      conf: raw.conf,
      bbox: raw.bbox,
      ...(raw.raw_classifications === undefined
        ? {}
        : { raw_classifications: raw.raw_classifications }),
      ...(raw.processed_classification === undefined
        ? {}
        : { processed_classification: raw.processed_classification }),
    },
  };
}

function parseImage(raw: unknown, path: string): Result<SpeciesNetImage> {
  if (!isRecord(raw)) return { ok: false, field: path };
  if (typeof raw.filepath !== 'string') return { ok: false, field: `${path}.filepath` };
  if (raw.country !== undefined && typeof raw.country !== 'string') {
    return { ok: false, field: `${path}.country` };
  }
  if (raw.failures !== undefined && !isStringArray(raw.failures)) {
    return { ok: false, field: `${path}.failures` };
  }

  const detections: SpeciesNetDetection[] = [];
  if (raw.detections !== undefined) {
    if (!Array.isArray(raw.detections)) return { ok: false, field: `${path}.detections` };
    for (let index = 0; index < raw.detections.length; index++) {
      const parsed = parseDetection(raw.detections[index], `${path}.detections[${index}]`);
      if (!parsed.ok) return parsed;
      detections.push(parsed.value);
    }
  }

  return {
    ok: true,
    value: {
      filepath: raw.filepath,
      detections,
      ...(raw.country === undefined ? {} : { country: raw.country }),
      ...(raw.failures === undefined ? {} : { failures: raw.failures }),
    },
  };
}

function parseEvent(raw: unknown, path: string): Result<SpeciesNetEvent> {
  if (!isRecord(raw)) return { ok: false, field: path };
  if (typeof raw.id !== 'string') return { ok: false, field: `${path}.id` };
  if (typeof raw.camera !== 'string') return { ok: false, field: `${path}.camera` };
  if (!isStringArray(raw.photos)) return { ok: false, field: `${path}.photos` };
  if (!isStringArray(raw.species)) return { ok: false, field: `${path}.species` };
  return {
    ok: true,
    value: {
      id: raw.id,
      camera: raw.camera,
      photos: raw.photos,
      species: raw.species,
    },
  };
}

function parseApp(raw: unknown): Result<SpeciesNetAppBlock> {
  if (!isRecord(raw)) return { ok: false, field: 'app' };
  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version)) {
    return { ok: false, field: 'app.version' };
  }
  if (!Array.isArray(raw.events)) return { ok: false, field: 'app.events' };
  if (!isStringMap(raw.corrections)) return { ok: false, field: 'app.corrections' };
  if (!isFiniteNumber(raw.independence_interval_min)) {
    return { ok: false, field: 'app.independence_interval_min' };
  }

  const events: SpeciesNetEvent[] = [];
  for (let index = 0; index < raw.events.length; index++) {
    const parsed = parseEvent(raw.events[index], `app.events[${index}]`);
    if (!parsed.ok) return parsed;
    events.push(parsed.value);
  }

  return {
    ok: true,
    value: {
      version: raw.version,
      events,
      corrections: raw.corrections,
      independenceIntervalMin: raw.independence_interval_min,
    },
  };
}

function topRawClasses(raw: Classifications): Classifications {
  const count = Math.min(raw.classes.length, raw.scores.length, NUM_CLASSIFICATIONS_FOR_ENSEMBLE);
  return { classes: raw.classes.slice(0, count), scores: raw.scores.slice(0, count) };
}

function exportImage(image: SpeciesNetImage) {
  return {
    filepath: image.filepath,
    ...(image.country === undefined ? {} : { country: image.country }),
    ...(image.failures === undefined ? {} : { failures: image.failures }),
    detections: image.detections.map((detection) => ({
      category: detection.category,
      label: detection.label,
      conf: detection.conf,
      bbox: detection.bbox,
      ...(detection.raw_classifications === undefined
        ? {}
        : { raw_classifications: topRawClasses(detection.raw_classifications) }),
      ...(detection.machine_classification === undefined
        ? {}
        : { machine_classification: detection.machine_classification }),
      ...(detection.processed_classification === undefined
        ? {}
        : { processed_classification: detection.processed_classification }),
    })),
  };
}

/**
 * Writes the SpeciesNet prediction shape and the app's event data in one file so an export can be
 * imported again without losing the raw classes that a country change needs.
 */
export function toSpeciesNetJson(input: SpeciesNetExport): string {
  return JSON.stringify(
    {
      info: { format_version: SPECIESNET_FORMAT_VERSION },
      predictions: input.predictions.map(exportImage),
      deerdiary: {
        version: EXPORT_VERSION,
        events: input.events,
        corrections: input.corrections,
        independence_interval_min: input.independenceIntervalMin,
      },
    },
    null,
    2,
  );
}

/**
 * SpeciesNet files can come from the CLI or another installation, so every field is checked before
 * use and the first failing path is reported for an error the user can act on.
 */
export function parseSpeciesNet(input: unknown): SpeciesNetParseResult {
  if (!isRecord(input)) return { ok: false, field: 'root' };
  if (!isRecord(input.info)) return { ok: false, field: 'info' };
  if (typeof input.info.format_version !== 'string') {
    return { ok: false, field: 'info.format_version' };
  }
  if (!Array.isArray(input.predictions)) return { ok: false, field: 'predictions' };

  const predictions: SpeciesNetImage[] = [];
  for (let index = 0; index < input.predictions.length; index++) {
    const parsed = parseImage(input.predictions[index], `predictions[${index}]`);
    if (!parsed.ok) return parsed;
    predictions.push(parsed.value);
  }

  // Earlier exports used the project's former name for the same block.
  const rawApp = input.deerdiary ?? input.wild;
  if (rawApp === undefined) {
    return { ok: true, value: { formatVersion: input.info.format_version, predictions } };
  }
  const app = parseApp(rawApp);
  if (!app.ok) return app;
  return {
    ok: true,
    value: { formatVersion: input.info.format_version, predictions, app: app.value },
  };
}
