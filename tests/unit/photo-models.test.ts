import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  defaultPhotoModelFiles,
  loadModels,
  type ModelEnvironment,
  type ModelManifest,
  ModelQuotaError,
  ModelUnpublishedError,
} from '../../src/app/models';
import { createPhotoModelLoader, modelDownloadText } from '../../src/app/photoModels';
import { PhotoPipeline } from '../../src/app/pipeline';
import { Classification } from '../../src/core/labels';
import { MemoryStorage, photos, readTime, session, TestWorker } from './fixtures/pipeline';

const HOST = 'https://huggingface.co/test/';
const bear = 'bear;mammalia;carnivora;ursidae;ursus;americanus;american black bear';
const geofence = { 'mammalia;carnivora;ursidae;ursus;americanus': { allow: { USA: [] } } };
const bodies: Record<string, string> = {
  'detector-fp32': 'detector weights',
  'detector-fp16': 'half detector weights',
  'classifier-fp32': 'full classifier weights',
  'classifier-fp16': 'classifier weights',
  labels: `${bear}\r\n${Classification.BLANK}\n`,
  taxonomy: `${bear}\n`,
  geofence: JSON.stringify(geofence),
};

function exported(id: string, role: string, precision?: string) {
  const body = bodies[id] ?? '';
  return {
    id,
    role,
    bytes: Buffer.byteLength(body),
    sha256: createHash('sha256').update(body).digest('hex'),
    ...(precision === undefined ? {} : { precision }),
  };
}

function manifest(unpublished: readonly string[] = []): ModelManifest {
  return {
    default_detector: 'detector-fp32',
    local_detector_exports: {
      files: [
        exported('detector-fp16', 'detector', 'fp16'),
        exported('detector-fp32', 'detector', 'fp32'),
      ],
    },
    local_exports: {
      files: [
        exported('classifier-fp32', 'classifier', 'fp32'),
        exported('classifier-fp16', 'classifier', 'fp16'),
        exported('labels', 'classifier_labels'),
        exported('taxonomy', 'taxonomy'),
        exported('geofence', 'geofence'),
      ],
    },
    files: Object.keys(bodies)
      .filter((id) => !unpublished.includes(id))
      .map((id) => ({ id, url: `${HOST}${id}` })),
  };
}

function setup(source = manifest()) {
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
    fetch: vi.fn<typeof fetch>(
      async (url) => new Response(bodies[String(url).slice(HOST.length)] ?? ''),
    ),
    caches: { open: vi.fn(async () => cache) },
    storage: {
      persist: vi.fn(async () => false),
      estimate: vi.fn(async (): Promise<StorageEstimate> => ({ quota: 1_000, usage: 0 })),
    },
    subtle: crypto.subtle,
  } satisfies ModelEnvironment;
  const loader = createPhotoModelLoader({
    baseUrl: 'http://localhost/deerdiary/',
    backend: 'wasm',
    files: () => defaultPhotoModelFiles(source),
    load: (files, needs, onProgress) =>
      loadModels(files, needs, onProgress, environment, exported('detector-fp32', 'detector')),
  });
  return { environment, loader };
}

function failure(loader: ReturnType<typeof setup>['loader']): string {
  const state = loader.state.value;
  if (state.status !== 'failed') throw new Error(`Expected a failed load, got ${state.status}`);
  return state.message;
}

it('selects the published production detector, fp16 classifier and their companion files', () => {
  expect(defaultPhotoModelFiles(manifest())).toEqual(
    [
      ['detector', 'detector-fp32'],
      ['classifier', 'classifier-fp16'],
      ['classifier_labels', 'labels'],
      ['taxonomy', 'taxonomy'],
      ['geofence', 'geofence'],
    ].map(([role, id = '']) => {
      const { bytes, sha256 } = exported(id, '');
      return { role, url: `${HOST}${id}`, bytes, sha256 };
    }),
  );
});

it.each([
  ['detector-fp32', 'detector'],
  ['classifier-fp16', 'classifier'],
  ['geofence', 'geofence'],
] as const)('refuses an export without a published address (%s)', (id, role) => {
  const resolve = () => defaultPhotoModelFiles(manifest([id]));
  expect(resolve).toThrow(ModelUnpublishedError);
  expect(resolve).toThrow(expect.objectContaining({ fileRole: role }));
});

it('rejects a manifest that lacks an export for a required role', () => {
  const source = manifest();
  const incomplete = {
    ...source,
    local_exports: {
      files: source.local_exports.files.filter(({ role }) => role !== 'taxonomy'),
    },
  };
  expect(() => defaultPhotoModelFiles(incomplete)).toThrow(
    'The taxonomy export is missing from the manifest.',
  );
});

it('reports download progress and builds the worker start request from verified files', async () => {
  const { loader } = setup();
  const seen: string[] = [];
  loader.state.subscribe((state) => {
    seen.push(
      state.status === 'loading' && state.progress
        ? `${state.progress.fileRole} ${state.progress.receivedBytes}/${state.progress.totalBytes}`
        : state.status,
    );
  });

  const init = await loader.init();

  const size = (id: string) => Buffer.byteLength(bodies[id] ?? '');
  expect(seen).toEqual([
    'idle',
    'loading',
    ...(
      [
        ['detector', 'detector-fp32'],
        ['classifier', 'classifier-fp16'],
        ['classifier_labels', 'labels'],
        ['taxonomy', 'taxonomy'],
        ['geofence', 'geofence'],
      ] as const
    ).flatMap(([role, id]) => [`${role} 0/${size(id)}`, `${role} ${size(id)}/${size(id)}`]),
    'ready',
  ]);
  expect(init).toEqual({
    kind: 'init',
    models: {
      detector: new TextEncoder().encode('detector weights'),
      classifier: new TextEncoder().encode('classifier weights'),
    },
    labels: [bear, Classification.BLANK],
    context: {
      taxonomyMap: expect.objectContaining({ 'mammalia;carnivora;ursidae;ursus;americanus': bear }),
      geofenceMap: geofence,
    },
    baseUrl: 'http://localhost/deerdiary/',
    backend: 'wasm',
  });
});

it('starts the photo worker with the loaded models and processes a drop', async () => {
  const { loader } = setup();
  const init = await loader.init();
  if (init === undefined) throw new Error('Expected loaded models');
  const worker = new TestWorker();
  const posted = vi.spyOn(worker, 'postMessage');
  const storage = new MemoryStorage();
  const pipeline = new PhotoPipeline({ storage, init, createWorker: () => worker, readTime });

  await pipeline.run(photos(2), session, 0);

  expect(posted.mock.calls[0]?.[0]).toBe(init);
  expect(worker.requests).toHaveLength(2);
  expect(pipeline.state.progress.value).toMatchObject({ done: 2, total: 2 });
  expect(storage.results.size).toBe(2);
});

it('shares one load between overlapping requests and reuses it afterwards', async () => {
  const { loader, environment } = setup();
  const [first, second] = await Promise.all([loader.init(), loader.init()]);
  expect(second).toBe(first);
  expect(await loader.init()).toBe(first);
  expect(environment.fetch).toHaveBeenCalledTimes(5);
});

it('reads a later page load from the cache without a download', async () => {
  const { environment } = setup();
  const source = manifest();
  const load = () =>
    createPhotoModelLoader({
      baseUrl: 'http://localhost/',
      backend: 'wasm',
      files: () => defaultPhotoModelFiles(source),
      load: (files, needs, onProgress) =>
        loadModels(files, needs, onProgress, environment, exported('detector-fp32', 'detector')),
    }).init();
  const first = await load();
  environment.fetch.mockClear();

  expect(await load()).toEqual(first);
  expect(environment.fetch).not.toHaveBeenCalled();
});

it('explains a pending publication and points to the local pipeline', async () => {
  const { loader, environment } = setup(manifest(['classifier-fp16']));

  expect(await loader.init()).toBeUndefined();

  expect(failure(loader)).toBe(
    'The species classifier has no published download yet, so this build cannot label photos. Run the reference pipeline on this computer instead.',
  );
  expect(environment.fetch).not.toHaveBeenCalled();
});

it('states both sizes when browser storage is too small', async () => {
  const loader = createPhotoModelLoader({
    baseUrl: 'http://localhost/',
    backend: 'wasm',
    files: () => defaultPhotoModelFiles(manifest()),
    load: async () => {
      throw new ModelQuotaError(192_500_000, 20_040_000);
    },
  });

  expect(await loader.init()).toBeUndefined();

  expect(failure(loader)).toBe(
    'The photo models need 192.5 MB of browser storage, but only 20.0 MB is free. Clear site data you no longer need in the browser settings, then drop the folder again.',
  );
});

it('names the file that failed its checksum and retries on the next request', async () => {
  const { loader, environment } = setup();
  environment.fetch.mockResolvedValueOnce(new Response('tampered weights'));

  expect(await loader.init()).toBeUndefined();
  expect(failure(loader)).toBe(
    'The detector download did not match its published checksum and was discarded. Drop the folder again to download it once more.',
  );

  expect(await loader.init()).toMatchObject({ kind: 'init' });
  expect(loader.state.value).toEqual({ status: 'ready' });
});

it('tells an offline user to reconnect', async () => {
  const { loader, environment } = setup();
  environment.fetch.mockRejectedValue(new TypeError('Failed to fetch'));

  expect(await loader.init()).toBeUndefined();

  expect(failure(loader)).toBe(
    'Could not reach the model host. Check the internet connection, then drop the folder again.',
  );
});

it('keeps the server response in the message when the host refuses a file', async () => {
  const { loader, environment } = setup();
  environment.fetch.mockResolvedValue(new Response('', { status: 503 }));

  expect(await loader.init()).toBeUndefined();

  expect(failure(loader)).toBe(
    'Could not load the photo models. Could not download detector: HTTP 503. Drop the folder again to retry.',
  );
});

it('rejects a geofence file that is not a map of allow and block rules', async () => {
  bodies.geofence = JSON.stringify({ 'mammalia;carnivora': { allow: { USA: 'all' } } });
  try {
    const { loader } = setup();

    expect(await loader.init()).toBeUndefined();

    expect(failure(loader)).toBe(
      'Could not load the photo models. The geographic ranges file is not a map of allow and block rules. Drop the folder again to retry.',
    );
  } finally {
    bodies.geofence = JSON.stringify(geofence);
  }
});

it('publishes one progress update per megabyte besides the start and end of a file', async () => {
  const shown: number[] = [];
  const loader = createPhotoModelLoader({
    baseUrl: 'http://localhost/',
    backend: 'wasm',
    files: () => defaultPhotoModelFiles(manifest()),
    load: async (_files, _needs, onProgress) => {
      for (const receivedBytes of [0, 400_000, 900_000, 1_200_000, 1_500_000, 2_300_000, 2_500_000])
        onProgress({ fileRole: 'detector', receivedBytes, totalBytes: 2_500_000 });
      onProgress({ fileRole: 'classifier', receivedBytes: 0, totalBytes: 9 });
      onProgress({ fileRole: 'classifier', receivedBytes: 9, totalBytes: 9 });
      throw new Error('Stopped after the progress under test.');
    },
  });
  loader.state.subscribe((state) => {
    if (state.status === 'loading' && state.progress) shown.push(state.progress.receivedBytes);
  });

  await loader.init();

  expect(shown).toEqual([0, 1_200_000, 2_300_000, 2_500_000, 0, 9]);
});

it('describes a download in megabytes', () => {
  expect(
    modelDownloadText({
      fileRole: 'classifier',
      receivedBytes: 56_148_281,
      totalBytes: 112_296_562,
    }),
  ).toBe('Downloading the species classifier: 56.1 of 112.3 MB.');
});
