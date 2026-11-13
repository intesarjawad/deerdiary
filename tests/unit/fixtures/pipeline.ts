import { vi } from 'vitest';
import type { PhotoWorker } from '../../../src/app/pipelineWorker';
import { Classification } from '../../../src/core/labels';
import type { CameraTime } from '../../../src/core/time';
import { scanFiles } from '../../../src/files/scan';
import type {
  Location,
  PipelineStorage,
  StorageBatch,
  StoredResult,
} from '../../../src/storage/schema';
import type { PhotoRequest, PhotoResult } from '../../../src/workers/photo';
import type { InitRequest, WorkerRequest, WorkerResponse } from '../../../src/workers/photo.worker';

const bear = 'bear;mammalia;carnivora;ursidae;ursus;americanus;american black bear';
export const raw = {
  classes: [
    bear,
    Classification.ANIMAL,
    Classification.HUMAN,
    Classification.VEHICLE,
    Classification.BLANK,
  ],
  scores: [0.95, 0.02, 0.01, 0.01, 0.01],
};
export const init: InitRequest = {
  kind: 'init',
  models: { detector: new Uint8Array([1]), classifier: new Uint8Array([2]) },
  labels: [],
  context: {
    taxonomyMap: {},
    geofenceMap: { 'mammalia;carnivora;ursidae;ursus;americanus': { allow: { USA: [] } } },
  },
  baseUrl: 'http://localhost/deerdiary/',
  backend: 'wasm',
};
export const time: CameraTime = {
  wallClockMs: Date.UTC(2026, 10, 1),
  wallClockHour: 0,
  timeSource: 'exif',
  offsetTimeOriginal: null,
  clockStatus: 'ok',
};
export const session = { id: 'session', createdAtMs: Date.UTC(2026, 10, 5) };
export const photos = (count: number) =>
  scanFiles(
    Array.from({ length: count }, (_, i) => new File(['jpeg'], `${i}.jpg`, { lastModified: 100 })),
  );
export const readTime = async () => time;

export function output(request: PhotoRequest): PhotoResult {
  return {
    path: request.settings.path ?? request.file.name,
    backend: 'wasm',
    ms: { decode: 0, preprocess: 0, detect: 0, classify: 0, ensemble: 0, thumbnail: 0, total: 0 },
    status: 'ok',
    width: 10,
    height: 10,
    thumbnail: new Blob(['preview']),
    detections: [
      { category: '1', conf: 0.9, bbox: [0, 0, 1, 1], label: 'animal', raw_classifications: raw },
    ],
  };
}

export class MemoryStorage implements PipelineStorage {
  memoryOnly = false;
  results = new Map<string, StoredResult>();
  batches: StorageBatch[] = [];
  location: Location | undefined;
  async loadResults(keys: readonly string[]) {
    return structuredClone(
      keys.flatMap((key) => {
        const result = this.results.get(key);
        return result ? [result] : [];
      }),
    );
  }
  async saveBatch(batch: StorageBatch) {
    this.batches.push(structuredClone(batch));
    for (const result of batch.results) this.results.set(result.key, structuredClone(result));
  }
  async loadLocation() {
    return this.location;
  }
  async saveLocation(location: Location) {
    this.location = location;
  }
}

export class TestWorker implements PhotoWorker {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly requests: PhotoRequest[] = [];
  readonly terminate = vi.fn();
  initialized = false;
  constructor(
    private readonly process: (request: PhotoRequest, worker: TestWorker) => void = (
      request,
      worker,
    ) => worker.send(output(request)),
  ) {}
  postMessage(request: WorkerRequest) {
    if ('kind' in request) {
      if (request.kind === 'init') {
        this.initialized = true;
        this.send({ kind: 'ready', backend: 'wasm', crossOriginIsolated: true });
        this.send({ kind: 'initialized', backend: request.backend, crossOriginIsolated: true });
      }
    } else {
      if (!this.initialized) throw new Error('Uninitialized worker');
      this.requests.push(request);
      this.process(request, this);
    }
  }
  send(data: WorkerResponse) {
    this.onmessage?.(new MessageEvent('message', { data }));
  }
  crash() {
    this.onerror?.(
      Object.assign(new Event('error'), {
        message: 'Worker crashed',
        filename: '',
        lineno: 0,
        colno: 0,
        error: undefined,
      }),
    );
  }
}
