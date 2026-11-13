import { signal } from '@preact/signals';
import { isGeofenceMap } from '../core/labels';
import { loadTaxonomy } from '../core/taxonomy';
import type { Backend } from '../workers/photo';
import type { InitRequest } from '../workers/photo.worker';
import {
  defaultPhotoModelFiles,
  loadModels,
  type ModelFile,
  ModelIntegrityError,
  type ModelNeeds,
  type ModelProgress,
  ModelQuotaError,
  type ModelRole,
  ModelUnpublishedError,
} from './models';

const MEGABYTE = 1_000_000;
// Network chunks arrive far more often than a person can read a changing number.
const PROGRESS_STEP_BYTES = MEGABYTE;
const ROLE_NAMES: Record<ModelRole, string> = {
  detector: 'detector',
  detector_reference: 'reference detector',
  classifier: 'species classifier',
  classifier_labels: 'species labels',
  taxonomy: 'taxonomy',
  geofence: 'geographic ranges',
  perch: 'audio model',
  perch_labels: 'audio labels',
};

export type ModelLoadState =
  | { status: 'idle' }
  // Progress stays null until a download starts; cached files are verified without one.
  | { status: 'loading'; progress: ModelProgress | null }
  | { status: 'ready' }
  | { status: 'failed'; message: string };

type PhotoModelLoaderOptions = {
  baseUrl: string;
  backend: Backend;
  files?: () => ModelFile[];
  load?: (
    files: readonly ModelFile[],
    needs: ModelNeeds,
    onProgress: (progress: ModelProgress) => void,
  ) => ReturnType<typeof loadModels>;
};

const megabytes = (bytes: number) => (bytes / MEGABYTE).toFixed(1);

export function modelDownloadText({ fileRole, receivedBytes, totalBytes }: ModelProgress): string {
  return `Downloading the ${ROLE_NAMES[fileRole]}: ${megabytes(receivedBytes)} of ${megabytes(totalBytes)} MB.`;
}

function failureMessage(error: unknown): string {
  if (error instanceof ModelUnpublishedError) {
    return `The ${ROLE_NAMES[error.fileRole]} has no published download yet, so this build cannot label photos. Run the reference pipeline on this computer instead.`;
  }
  if (error instanceof ModelQuotaError) {
    return `The photo models need ${megabytes(error.requiredBytes)} MB of browser storage, but only ${megabytes(error.availableBytes)} MB is free. Clear site data you no longer need in the browser settings, then drop the folder again.`;
  }
  if (error instanceof ModelIntegrityError) {
    return `The ${ROLE_NAMES[error.fileRole]} download did not match its published checksum and was discarded. Drop the folder again to download it once more.`;
  }
  // fetch rejects with a TypeError only when no response arrived.
  if (error instanceof TypeError) {
    return 'Could not reach the model host. Check the internet connection, then drop the folder again.';
  }
  const reason = error instanceof Error ? error.message : String(error);
  return `Could not load the photo models. ${reason} Drop the folder again to retry.`;
}

function photoInit(
  models: ReadonlyMap<ModelRole, ArrayBuffer>,
  baseUrl: string,
  backend: Backend,
): InitRequest {
  const bytes = (role: ModelRole) => {
    const buffer = models.get(role);
    if (!buffer) throw new Error(`The ${ROLE_NAMES[role]} file was not loaded.`);
    return new Uint8Array(buffer);
  };
  const text = (role: ModelRole) => new TextDecoder().decode(bytes(role));
  const geofenceMap: unknown = JSON.parse(text('geofence'));
  if (!isGeofenceMap(geofenceMap)) {
    throw new Error(`The ${ROLE_NAMES.geofence} file is not a map of allow and block rules.`);
  }
  return {
    kind: 'init',
    models: { detector: bytes('detector'), classifier: bytes('classifier') },
    labels: text('classifier_labels').trim().split(/\r?\n/),
    context: { taxonomyMap: loadTaxonomy(text('taxonomy')), geofenceMap },
    baseUrl,
    backend,
  };
}

/** Loads the default photo models once per page and reports each stage for the interface. */
export function createPhotoModelLoader({
  baseUrl,
  backend,
  files = () => defaultPhotoModelFiles(undefined, import.meta.env.DEV),
  load = loadModels,
}: PhotoModelLoaderOptions) {
  const state = signal<ModelLoadState>({ status: 'idle' });
  let loaded: Promise<InitRequest | undefined> | undefined;

  async function start(): Promise<InitRequest | undefined> {
    state.value = { status: 'loading', progress: null };
    let shownBytes = 0;
    try {
      const { models } = await load(
        files(),
        { hasPhotos: true, hasVideos: false, hasAudio: false, mode: 'default' },
        (progress) => {
          const { receivedBytes, totalBytes } = progress;
          const boundary = receivedBytes === 0 || receivedBytes === totalBytes;
          if (!boundary && receivedBytes - shownBytes < PROGRESS_STEP_BYTES) return;
          shownBytes = receivedBytes;
          state.value = { status: 'loading', progress };
        },
      );
      const init = photoInit(models, baseUrl, backend);
      state.value = { status: 'ready' };
      return init;
    } catch (error) {
      // A failed load is forgotten so that the next drop starts another.
      loaded = undefined;
      state.value = { status: 'failed', message: failureMessage(error) };
      return undefined;
    }
  }

  return {
    state,
    /** Resolves to the worker's start request, or undefined once `state` holds the failure. */
    init(): Promise<InitRequest | undefined> {
      loaded ??= start();
      return loaded;
    },
  };
}
