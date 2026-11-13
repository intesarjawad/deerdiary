import { signal } from '@preact/signals';
import type { EnsembleContext } from '../core/labels';
import type { CameraTime } from '../core/time';
import { readCameraTime } from '../files/exif';
import type { ScannedFile } from '../files/scan';
import { fileKey, type StoredResult } from '../storage/schema';
import type { ClassifiedDetection, PhotoResult, StageTimes } from '../workers/photo';
import {
  applyCountry,
  hasCountryFixedLabels,
  hasRelabelableDetections,
  type ImportedBatch,
  type ImportedPhoto,
  importErrorMessage,
  matchPhotoPath,
  parseImport,
} from './import';

// A prediction file records no stage timings.
const NO_TIMES: StageTimes = {
  decode: 0,
  preprocess: 0,
  detect: 0,
  classify: 0,
  ensemble: 0,
  thumbnail: 0,
  total: 0,
};

type OutputResult = { ok: true; value: PhotoResult } | { ok: false; field: string };

function isCategory(value: string): value is ClassifiedDetection['category'] {
  return value === '1' || value === '2' || value === '3';
}

/**
 * Turns one imported photo into the result the diary reads. `field` names the photo in the file,
 * so a detector category the diary cannot show is reported where it sits.
 */
export function importedOutput(
  photo: ImportedPhoto,
  { path, thumbnail, field }: { path: string; thumbnail: Blob; field: string },
): OutputResult {
  if (photo.failures !== undefined) {
    return { ok: true, value: { path, backend: 'wasm', ms: NO_TIMES, status: 'decode_failed' } };
  }
  const detections: ClassifiedDetection[] = [];
  for (const [index, detection] of photo.detections.entries()) {
    if (!isCategory(detection.category)) {
      return { ok: false, field: `${field}.detections[${index}].category` };
    }
    detections.push({
      category: detection.category,
      label: detection.label,
      conf: detection.conf,
      bbox: detection.bbox,
      ...(detection.raw_classifications === undefined
        ? {}
        : { raw_classifications: detection.raw_classifications }),
      ...(detection.processed_classification === undefined
        ? {}
        : { processed_classification: detection.processed_classification }),
    });
  }
  return {
    ok: true,
    value: {
      path,
      backend: 'wasm',
      ms: NO_TIMES,
      status: 'ok',
      width: 0,
      height: 0,
      thumbnail,
      detections,
    },
  };
}

export type DiaryImportState =
  | { status: 'idle' }
  | { status: 'reading' }
  // The file holds no capture times, so the diary waits for the photos it describes.
  | { status: 'waiting'; photoCount: number }
  | { status: 'shown'; photoCount: number; unmatchedCount: number; countryFixed: boolean }
  | { status: 'failed'; message: string };

type MatchedPhoto = { scanned: ScannedFile; file: File; time: CameraTime };

type DiaryImporterOptions = {
  /** Replaces the diary on screen; previews are the dropped originals. */
  show: (results: readonly StoredResult[], corrections: Readonly<Record<string, string>>) => void;
  /** Resolves to the taxonomy and ranges a country change needs, or undefined if they failed. */
  ensembleContext: () => Promise<EnsembleContext | undefined>;
  readTime?: typeof readCameraTime;
};

function photoField(batch: ImportedBatch, index: number): string {
  return `${batch.format === 'speciesnet' ? 'predictions' : 'images'}[${index}]`;
}

function firstBadField(batch: ImportedBatch): string | undefined {
  for (const [index, photo] of batch.photos.entries()) {
    const field = photoField(batch, index);
    const output = importedOutput(photo, { path: photo.path, thumbnail: new Blob([]), field });
    if (!output.ok) return output.field;
  }
  return undefined;
}

function diaryResults(
  batch: ImportedBatch,
  matched: ReadonlyMap<number, MatchedPhoto>,
): StoredResult[] {
  return batch.photos.flatMap((photo, index) => {
    const found = matched.get(index);
    if (found === undefined) return [];
    const { scanned, file, time } = found;
    const output = importedOutput(photo, {
      path: scanned.path,
      thumbnail: file,
      field: photoField(batch, index),
    });
    // Every category was checked when the file was read.
    return output.ok ? [{ key: fileKey(scanned), time, output: output.value }] : [];
  });
}

/** Reads a SpeciesNet or MegaDetector predictions file and shows it once its photos are dropped. */
export function createDiaryImporter({
  show,
  ensembleContext,
  readTime = readCameraTime,
}: DiaryImporterOptions) {
  const state = signal<DiaryImportState>({ status: 'idle' });
  let pending: ImportedBatch | undefined;
  let current: { batch: ImportedBatch; matched: Map<number, MatchedPhoto> } | undefined;

  /** Keyed by the photo's index in the file; a dropped photo answers at most one prediction. */
  async function match(batch: ImportedBatch, folder: readonly ScannedFile[], dropMs: number) {
    const photos = new Map(
      folder.filter(({ kind }) => kind === 'photo').map((entry) => [entry.path, entry]),
    );
    const paths = [...photos.keys()];
    const used = new Set<string>();
    const matched = new Map<number, MatchedPhoto>();
    for (const [index, photo] of batch.photos.entries()) {
      const path = matchPhotoPath(photo.path, paths);
      const scanned = path === undefined ? undefined : photos.get(path);
      if (scanned === undefined || used.has(scanned.path)) continue;
      used.add(scanned.path);
      const file = 'getFile' in scanned.source ? await scanned.source.getFile() : scanned.source;
      const time = await readTime({ ...scanned, source: file }, dropMs);
      matched.set(index, { scanned, file, time });
    }
    return matched;
  }

  async function attach(folder: readonly ScannedFile[], dropWallClockMs: number): Promise<void> {
    const batch = pending;
    if (batch === undefined) return;
    try {
      const matched = await match(batch, folder, dropWallClockMs);
      if (matched.size === 0) {
        state.value = {
          status: 'failed',
          message: `None of the ${batch.photos.length} photos in the predictions file is in this folder. Drop the folder the predictions were made from.`,
        };
        return;
      }
      pending = undefined;
      current = { batch, matched };
      show(diaryResults(batch, matched), batch.corrections);
      state.value = {
        status: 'shown',
        photoCount: matched.size,
        unmatchedCount: batch.photos.length - matched.size,
        countryFixed: hasCountryFixedLabels(batch),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      state.value = {
        status: 'failed',
        message: `Could not import the predictions. ${reason} Drop the folder again to retry.`,
      };
    }
  }

  return {
    state,
    /** True while a read file still needs its photo folder. */
    needsFolder: () => pending !== undefined,
    /** `folder` is the folder already dropped on this page, if any. */
    async read(file: File, folder: readonly ScannedFile[], dropWallClockMs: number): Promise<void> {
      pending = undefined;
      state.value = { status: 'reading' };
      let text: string;
      try {
        text = await file.text();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        state.value = {
          status: 'failed',
          message: `Could not read ${file.name}. ${reason} Choose the file again to retry.`,
        };
        return;
      }
      const parsed = parseImport(text);
      const bad = parsed.ok ? firstBadField(parsed.value) : parsed.field;
      if (!parsed.ok || bad !== undefined) {
        state.value = { status: 'failed', message: importErrorMessage(bad ?? 'root') };
        return;
      }
      if (parsed.value.photos.length === 0) {
        state.value = {
          status: 'failed',
          message:
            'The predictions file lists no photos. Pick the file written for the photo folder.',
        };
        return;
      }
      pending = parsed.value;
      if (folder.some(({ kind }) => kind === 'photo')) {
        await attach(folder, dropWallClockMs);
      } else {
        state.value = { status: 'waiting', photoCount: parsed.value.photos.length };
      }
    },
    attach,
    /** Forgets the imported file once a run on the models replaces the diary. */
    reset() {
      pending = undefined;
      current = undefined;
      state.value = { status: 'idle' };
    },
    /** Re-applies the geographic step to the imported labels that kept all five raw classes. */
    async setCountry(country: string | undefined): Promise<void> {
      const shown = current;
      if (shown === undefined || !hasRelabelableDetections(shown.batch)) return;
      const context = await ensembleContext();
      if (context === undefined || current !== shown) return;
      const batch = applyCountry(shown.batch, { ...context, country });
      show(diaryResults(batch, shown.matched), shown.batch.corrections);
    },
  };
}

export type DiaryImporter = ReturnType<typeof createDiaryImporter>;
