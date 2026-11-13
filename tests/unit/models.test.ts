import { expect, test, vi } from 'vitest';
import {
  defaultPhotoModelBytes,
  defaultPhotoModelFiles,
  loadModels,
  MODEL_CACHE_NAME,
  type ModelEnvironment,
  type ModelFile,
  ModelIntegrityError,
  type ModelManifest,
  type ModelNeeds,
  type ModelProgress,
  ModelQuotaError,
  ModelUnpublishedError,
  requiredModelRoles,
} from '../../src/app/models';

const audioNeeds: ModelNeeds = {
  hasPhotos: false,
  hasVideos: false,
  hasAudio: true,
  mode: 'default',
};
const bytes = new TextEncoder().encode('abc');
const sha256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const files: ModelFile[] = ['perch', 'perch_labels'].map((role, index) => ({
  role: index === 0 ? 'perch' : 'perch_labels',
  url: `https://huggingface.co/test/${role}`,
  bytes: bytes.length,
  sha256,
}));

function setup() {
  const entries = new Map<string, Response>();
  const cache = {
    match: vi.fn(async (request: RequestInfo | URL) => entries.get(String(request))?.clone()),
    put: vi.fn(async (request: RequestInfo | URL, response: Response) => {
      entries.set(String(request), response.clone());
    }),
    delete: vi.fn(async (request: RequestInfo | URL) => entries.delete(String(request))),
    add: vi.fn(),
    addAll: vi.fn(),
    keys: vi.fn(),
    matchAll: vi.fn(),
  };
  const environment = {
    fetch: vi.fn<typeof fetch>(async () => new Response(bytes)),
    caches: { open: vi.fn(async () => cache) },
    storage: {
      persist: vi.fn(async () => false),
      estimate: vi.fn(async (): Promise<StorageEstimate> => ({ quota: 100, usage: 10 })),
    },
    subtle: crypto.subtle,
  } satisfies ModelEnvironment;
  return { environment, entries, cache };
}

test('streams byte progress, verifies SHA-256 and caches each selected role', async () => {
  const { environment, cache } = setup();
  environment.fetch.mockImplementation(async () => {
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 1));
          controller.enqueue(bytes.slice(1));
          controller.close();
        },
      }),
    );
  });
  const progress: ModelProgress[] = [];
  const result = await loadModels(files, audioNeeds, (value) => progress.push(value), environment);
  expect(result.persisted).toBe(false);
  expect(environment.storage.persist).toHaveBeenCalledOnce();
  expect(environment.caches.open).toHaveBeenCalledWith(MODEL_CACHE_NAME);
  expect(cache.put).toHaveBeenCalledTimes(2);
  expect(new Uint8Array(result.models.get('perch') ?? new ArrayBuffer(0))).toEqual(bytes);
  expect(progress).toEqual(
    files.flatMap((file) =>
      [0, 1, 3].map((receivedBytes) => ({ fileRole: file.role, receivedBytes, totalBytes: 3 })),
    ),
  );
});

test('a second load uses verified cache bytes without fetching or quota checks', async () => {
  const { environment } = setup();
  await loadModels(files, audioNeeds, undefined, environment);
  environment.fetch.mockClear();
  environment.storage.estimate.mockClear();
  environment.storage.persist.mockResolvedValue(true);
  const result = await loadModels(files, audioNeeds, undefined, environment);
  expect(result.persisted).toBe(true);
  expect(result.models.size).toBe(2);
  expect(environment.fetch).not.toHaveBeenCalled();
  expect(environment.storage.estimate).not.toHaveBeenCalled();
});

test('refuses the full uncached size before any download and reports both sizes', async () => {
  const { environment } = setup();
  environment.storage.estimate.mockResolvedValue({ quota: 15, usage: 10 });
  const loading = loadModels(files, audioNeeds, undefined, environment);
  await expect(loading).rejects.toEqual(new ModelQuotaError(6, 5));
  await expect(loading).rejects.toThrow('6 bytes, but only 5 bytes');
  expect(environment.fetch).not.toHaveBeenCalled();
});

test('quota counts only missing files and permits exactly enough space', async () => {
  const { environment, entries } = setup();
  entries.set('https://huggingface.co/test/perch', new Response(bytes));
  environment.storage.estimate.mockResolvedValue({ quota: 13, usage: 10 });
  await loadModels(files, audioNeeds, undefined, environment);
  expect(environment.fetch).toHaveBeenCalledExactlyOnceWith(
    'https://huggingface.co/test/perch_labels',
  );
});

test.each(['network', 'cache'])(
  'deletes a corrupt %s entry and identifies its role',
  async (source) => {
    const { environment, entries, cache } = setup();
    if (source === 'cache') {
      entries.set('https://huggingface.co/test/perch', new Response('bad'));
    } else {
      environment.fetch.mockResolvedValue(new Response('bad'));
    }
    await expect(loadModels(files, audioNeeds, undefined, environment)).rejects.toEqual(
      new ModelIntegrityError('perch'),
    );
    expect(cache.delete).toHaveBeenCalledWith('https://huggingface.co/test/perch');
    expect(cache.put).not.toHaveBeenCalled();
    expect(entries.has('https://huggingface.co/test/perch')).toBe(false);
  },
);

test.each(['ab', 'abcd'])('rejects a wrong byte count (%s)', async (body) => {
  const { environment, cache } = setup();
  environment.fetch.mockResolvedValue(new Response(body));
  await expect(loadModels(files, audioNeeds, undefined, environment)).rejects.toBeInstanceOf(
    ModelIntegrityError,
  );
  expect(cache.put).not.toHaveBeenCalled();
});

test('does not cache an unsuccessful HTTP response', async () => {
  const { environment, cache } = setup();
  environment.fetch.mockResolvedValue(new Response('unavailable', { status: 503 }));
  await expect(loadModels(files, audioNeeds, undefined, environment)).rejects.toThrow('HTTP 503');
  expect(cache.put).not.toHaveBeenCalled();
});

test('propagates stream failures without caching partial bytes', async () => {
  const { environment, cache } = setup();
  environment.fetch.mockResolvedValue(
    new Response(
      new ReadableStream({ start: (controller) => controller.error(new Error('offline')) }),
    ),
  );
  await expect(loadModels(files, audioNeeds, undefined, environment)).rejects.toThrow('offline');
  expect(cache.put).not.toHaveBeenCalled();
});

test('refuses downloads when quota cannot be determined', async () => {
  const { environment } = setup();
  environment.storage.estimate.mockResolvedValue({});
  await expect(loadModels(files, audioNeeds, undefined, environment)).rejects.toThrow(
    'storage availability could not be determined',
  );
  expect(environment.fetch).not.toHaveBeenCalled();
});

test('roles follow folder media and Reference mode without unnecessary downloads', () => {
  expect(requiredModelRoles({ ...audioNeeds, hasAudio: false })).toEqual([]);
  expect(requiredModelRoles(audioNeeds)).toEqual(['perch', 'perch_labels']);
  const photoRoles = ['detector', 'classifier', 'classifier_labels', 'taxonomy', 'geofence'];
  expect(requiredModelRoles({ ...audioNeeds, hasAudio: false, hasPhotos: true })).toEqual(
    photoRoles,
  );
  expect(requiredModelRoles({ ...audioNeeds, hasAudio: false, hasVideos: true })).toEqual(
    photoRoles,
  );
  expect(requiredModelRoles({ ...audioNeeds, hasPhotos: true, mode: 'reference' })).toEqual([
    'detector_reference',
    ...photoRoles.slice(1),
    'perch',
    'perch_labels',
  ]);
});

test('requires an explicit unambiguous file choice before accessing storage', async () => {
  const { environment } = setup();
  for (const selection of [[], [...files, ...files]]) {
    await expect(loadModels(selection, audioNeeds, undefined, environment)).rejects.toThrow(
      'Select exactly one model file for perch',
    );
  }
  expect(environment.storage.persist).not.toHaveBeenCalled();
});

test('does not fetch inactive roles supplied alongside the selected audio files', async () => {
  const { environment } = setup();
  await loadModels(
    [
      ...files,
      {
        role: 'detector_reference',
        url: 'https://huggingface.co/test/reference',
        bytes: 3,
        sha256,
      },
      { role: 'classifier', url: 'https://huggingface.co/test/classifier', bytes: 3, sha256 },
    ],
    audioNeeds,
    undefined,
    environment,
  );
  expect(environment.fetch.mock.calls.map(([url]) => url)).toEqual(files.map((file) => file.url));
});

test('rejects missing integrity metadata before storage or network access', async () => {
  const { environment } = setup();
  await expect(
    loadModels(
      files.map((file) => ({ ...file, sha256: '' })),
      audioNeeds,
      undefined,
      environment,
    ),
  ).rejects.toThrow('Invalid size or SHA-256');
  expect(environment.storage.persist).not.toHaveBeenCalled();
  expect(environment.fetch).not.toHaveBeenCalled();
});

test('default photo mode rejects a comparison detector before any download', async () => {
  const { environment } = setup();
  const needs: ModelNeeds = { ...audioNeeds, hasPhotos: true, hasAudio: false };
  const candidate: ModelFile = {
    role: 'detector',
    url: 'https://example.com/candidate.onnx',
    bytes: bytes.length,
    sha256,
  };
  await expect(loadModels([candidate], needs, undefined, environment)).rejects.toThrow(
    'production fp32 detector',
  );
  expect(environment.fetch).not.toHaveBeenCalled();
});

test('counts a default photo download from the exports before they are published', () => {
  const exported = (id: string, role: string, size: number, precision?: string) => ({
    id,
    role,
    bytes: size,
    sha256,
    ...(precision === undefined ? {} : { precision }),
  });
  const source: ModelManifest = {
    default_detector: 'chosen',
    local_detector_exports: {
      files: [exported('candidate', 'detector', 1), exported('chosen', 'detector', 100)],
    },
    local_exports: {
      files: [
        exported('fp32', 'classifier', 1_000, 'fp32'),
        exported('fp16', 'classifier', 500, 'fp16'),
        exported('labels', 'classifier_labels', 10),
        exported('taxonomy', 'taxonomy', 20),
        exported('geofence', 'geofence', 30),
      ],
    },
    files: [],
  };

  expect(defaultPhotoModelBytes(source)).toBe(660);
  expect(() => defaultPhotoModelFiles(source)).toThrow(ModelUnpublishedError);
});

test('a local photo model set needs no publication and keeps the export size and hash', () => {
  const entry = (id: string, role: string, precision?: string) => ({
    id,
    role,
    bytes: 7,
    sha256: 'a'.repeat(64),
    ...(precision && { precision }),
  });
  const source: ModelManifest = {
    default_detector: 'det',
    local_detector_exports: { files: [entry('det', 'detector')] },
    local_exports: {
      files: [
        entry('cls', 'classifier', 'fp16'),
        entry('labels', 'classifier_labels'),
        entry('tax', 'taxonomy'),
        entry('geo', 'geofence'),
      ],
    },
    files: [],
  };

  const files = defaultPhotoModelFiles(source, true);
  expect(files.map((file) => file.url)).toEqual(
    ['det', 'cls', 'labels', 'tax', 'geo'].map((id) => `/__local-models/${id}`),
  );
  expect(files.every((file) => file.bytes === 7 && file.sha256 === 'a'.repeat(64))).toBe(true);
  expect(() => defaultPhotoModelFiles(source)).toThrow(ModelUnpublishedError);
});
