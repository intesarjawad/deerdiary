import manifest from '../../models/manifest.json';

export type ModelRole =
  | 'detector'
  | 'detector_reference'
  | 'classifier'
  | 'classifier_labels'
  | 'taxonomy'
  | 'geofence'
  | 'perch'
  | 'perch_labels';

export type ModelFile = {
  role: ModelRole;
  url: string;
  bytes: number;
  sha256: string;
};

export type ModelNeeds = {
  hasPhotos: boolean;
  hasVideos: boolean;
  hasAudio: boolean;
  mode: 'default' | 'reference';
};

export type ModelProgress = { fileRole: ModelRole; receivedBytes: number; totalBytes: number };

export type ModelEnvironment = {
  fetch: typeof fetch;
  caches: Pick<CacheStorage, 'open'>;
  storage: Pick<StorageManager, 'persist' | 'estimate'>;
  subtle: Pick<SubtleCrypto, 'digest'>;
};

type ExportedFile = {
  id: string;
  role: string;
  bytes: number;
  sha256: string;
  precision?: string;
};

/** The manifest fields that choose and locate model files. */
export type ModelManifest = {
  default_detector: string;
  local_detector_exports: { files: readonly ExportedFile[] };
  local_exports: { files: readonly ExportedFile[] };
  files: readonly { id: string; url: string }[];
};

// ADR 0003: the fp16 classifier serves both backends.
const CLASSIFIER_PRECISION = 'fp16';

/** Served by the Vite dev server only, from each export's `local_path`. */
export const LOCAL_MODEL_PATH = '/__local-models/';

export const MODEL_CACHE_NAME = 'deerdiary-models-v1';

export class ModelIntegrityError extends Error {
  readonly fileRole: ModelRole;

  constructor(fileRole: ModelRole) {
    super(`The ${fileRole} download failed SHA-256 verification. Please download it again.`);
    this.name = 'ModelIntegrityError';
    this.fileRole = fileRole;
  }
}

export class ModelUnpublishedError extends Error {
  readonly fileRole: ModelRole;

  constructor(fileRole: ModelRole) {
    super(`The ${fileRole} export is pending publication.`);
    this.name = 'ModelUnpublishedError';
    this.fileRole = fileRole;
  }
}

export class ModelQuotaError extends Error {
  readonly requiredBytes: number;
  readonly availableBytes: number;

  constructor(requiredBytes: number, availableBytes: number) {
    super(
      `Model downloads need ${requiredBytes} bytes, but only ${availableBytes} bytes are available. Free browser storage and try again.`,
    );
    this.name = 'ModelQuotaError';
    this.requiredBytes = requiredBytes;
    this.availableBytes = availableBytes;
  }
}

/** Selects roles only; model and precision choices remain with the caller. */
export function requiredModelRoles(needs: ModelNeeds): ModelRole[] {
  const roles: ModelRole[] = [];
  if (needs.hasPhotos || needs.hasVideos) {
    roles.push(
      needs.mode === 'reference' ? 'detector_reference' : 'detector',
      'classifier',
      'classifier_labels',
      'taxonomy',
      'geofence',
    );
  }
  if (needs.hasAudio) roles.push('perch', 'perch_labels');
  return roles;
}

async function verify(file: ModelFile, bytes: ArrayBuffer, subtle: ModelEnvironment['subtle']) {
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  const actual = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== file.sha256 || bytes.byteLength !== file.bytes) {
    throw new ModelIntegrityError(file.role);
  }
}

async function download(
  file: ModelFile,
  environment: ModelEnvironment,
  onProgress: (progress: ModelProgress) => void,
): Promise<ArrayBuffer> {
  const response = await environment.fetch(file.url);
  if (!response.ok) throw new Error(`Could not download ${file.role}: HTTP ${response.status}.`);
  if (!response.body) throw new Error(`The ${file.role} download has no response body.`);
  const reader = response.body.getReader();
  const bytes = new Uint8Array(file.bytes);
  let receivedBytes = 0;
  onProgress({ fileRole: file.role, receivedBytes, totalBytes: file.bytes });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > file.bytes) throw new ModelIntegrityError(file.role);
      bytes.set(value, receivedBytes - value.byteLength);
      onProgress({ fileRole: file.role, receivedBytes, totalBytes: file.bytes });
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (receivedBytes !== file.bytes) throw new ModelIntegrityError(file.role);
  await verify(file, bytes.buffer, environment.subtle);
  return bytes.buffer;
}

/**
 * Fetches selected roles and retains persistence permission for the storage banner. Default mode
 * accepts only the production detector, the manifest's export unless the caller names another.
 */
export async function loadModels(
  selectedFiles: readonly ModelFile[],
  needs: ModelNeeds,
  onProgress: (progress: ModelProgress) => void = () => {},
  environment: ModelEnvironment = {
    fetch: globalThis.fetch.bind(globalThis),
    caches: globalThis.caches,
    storage: navigator.storage,
    subtle: crypto.subtle,
  },
  productionDetector: Pick<ModelFile, 'bytes' | 'sha256'> = productionDetectorMetadata(),
): Promise<{ persisted: boolean; models: Map<ModelRole, ArrayBuffer> }> {
  const files = requiredModelRoles(needs).map((role) => {
    const matches = selectedFiles.filter((file) => file.role === role);
    const file = matches[0];
    if (!file || matches.length !== 1) {
      throw new Error(`Select exactly one model file for ${role}.`);
    }
    if (
      !Number.isSafeInteger(file.bytes) ||
      file.bytes <= 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    ) {
      throw new Error(`Invalid size or SHA-256 in the ${role} manifest entry.`);
    }
    if (
      role === 'detector' &&
      (file.sha256 !== productionDetector.sha256 || file.bytes !== productionDetector.bytes)
    ) {
      throw new Error('Default mode requires the production fp32 detector.');
    }
    return file;
  });
  const persisted = await environment.storage.persist();
  const cache = await environment.caches.open(MODEL_CACHE_NAME);
  const models = new Map<ModelRole, ArrayBuffer>();
  const missing: ModelFile[] = [];
  for (const file of files) {
    const cached = await cache.match(file.url);
    if (!cached) {
      missing.push(file);
      continue;
    }
    const bytes = await cached.arrayBuffer();
    try {
      await verify(file, bytes, environment.subtle);
    } catch (error) {
      await cache.delete(file.url);
      throw error;
    }
    models.set(file.role, bytes);
  }
  if (missing.length > 0) {
    const { quota, usage } = await environment.storage.estimate();
    if (quota === undefined || usage === undefined) {
      throw new Error(
        'Browser storage availability could not be determined. No models downloaded.',
      );
    }
    const availableBytes = Math.max(0, quota - usage);
    const requiredBytes = missing.reduce((sum, file) => sum + file.bytes, 0);
    if (requiredBytes > availableBytes) throw new ModelQuotaError(requiredBytes, availableBytes);
    for (const file of missing) {
      let bytes: ArrayBuffer;
      try {
        bytes = await download(file, environment, onProgress);
      } catch (error) {
        if (error instanceof ModelIntegrityError) await cache.delete(file.url);
        throw error;
      }
      await cache.put(file.url, new Response(bytes));
      models.set(file.role, bytes);
    }
  }
  return { persisted, models };
}

function productionDetectorMetadata(source: ModelManifest = manifest) {
  const selected = source.local_detector_exports.files.find(
    (file) => file.id === source.default_detector,
  );
  if (!selected) throw new Error('The default detector is missing from the manifest.');
  return selected;
}

function publishedFile(
  role: ModelRole,
  selected: ExportedFile | undefined,
  source: ModelManifest,
  local: boolean,
): ModelFile {
  if (!selected) throw new Error(`The ${role} export is missing from the manifest.`);
  if (local) {
    return {
      role,
      url: `${LOCAL_MODEL_PATH}${selected.id}`,
      bytes: selected.bytes,
      sha256: selected.sha256,
    };
  }
  const published = source.files.find((file) => file.id === selected.id);
  if (!published) throw new ModelUnpublishedError(role);
  return { role, url: published.url, bytes: selected.bytes, sha256: selected.sha256 };
}

/** Resolves the production choice without substituting a published comparison candidate. */
export function defaultDetectorFile(source: ModelManifest = manifest): ModelFile {
  return publishedFile('detector', productionDetectorMetadata(source), source, false);
}

function photoModelExports(source: ModelManifest): [ModelRole, ExportedFile | undefined][] {
  const exported = (role: ModelRole) =>
    source.local_exports.files.find(
      (file) =>
        file.role === role && (role !== 'classifier' || file.precision === CLASSIFIER_PRECISION),
    );
  return [
    ['detector', productionDetectorMetadata(source)],
    ['classifier', exported('classifier')],
    ['classifier_labels', exported('classifier_labels')],
    ['taxonomy', exported('taxonomy')],
    ['geofence', exported('geofence')],
  ];
}

/**
 * Resolves the one file per role that a default-mode photo drop loads. `local` points them at the
 * dev server's copies of the exports, for trying unpublished models.
 */
export function defaultPhotoModelFiles(
  source: ModelManifest = manifest,
  local = false,
): ModelFile[] {
  return photoModelExports(source).map(([role, selected]) =>
    publishedFile(role, selected, source, local),
  );
}

/** The bytes a default-mode photo drop downloads, known from the exports before publication. */
export function defaultPhotoModelBytes(source: ModelManifest = manifest): number {
  return photoModelExports(source).reduce((total, [role, selected]) => {
    if (!selected) throw new Error(`The ${role} export is missing from the manifest.`);
    return total + selected.bytes;
  }, 0);
}

/** Names the detector a default-mode run uses, for exports that record it. */
export const DEFAULT_DETECTOR_ID = manifest.default_detector;
