import { isGeofenceMap } from '../../src/core/labels';
import { loadTaxonomy } from '../../src/core/taxonomy';
import type { Backend, PhotoRequest, PhotoResult, PhotoSettings } from '../../src/workers/photo';
import type { InitRequest, WorkerResponse } from '../../src/workers/photo.worker';

export type HarnessConfig = {
  backend: Backend;
  modelBaseUrl: string;
  detector: string;
  detectorKind?: InitRequest['detector'];
  classifier: string;
  classifier_labels: string;
  taxonomy: string;
  geofence: string;
};

declare global {
  interface Window {
    photoHarness: {
      initialize(config: HarnessConfig): Promise<{ backend: Backend }>;
      process(
        url: string,
        detections?: PhotoRequest['detections'],
        settings?: PhotoSettings,
      ): Promise<PhotoResult>;
      close(): void;
    };
  }
}

const worker = new Worker(new URL('../../src/workers/photo.worker.ts', import.meta.url), {
  type: 'module',
});
let pending: { resolve(value: WorkerResponse): void; reject(error: Error): void } | undefined;
worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
  const value = event.data;
  if (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    (value.kind === 'ready' || value.kind === 'network-resources')
  )
    return;
  if (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    value.status === 'inference_failed'
  ) {
    pending?.reject(new Error(JSON.stringify(value)));
  } else pending?.resolve(value);
  pending = undefined;
};
worker.onerror = (event) => {
  pending?.reject(new Error(event.message));
  pending = undefined;
};
function send(
  request: InitRequest | PhotoRequest,
  transfer: Transferable[] = [],
): Promise<WorkerResponse> {
  if (pending) throw new Error('Wait for the previous photo request');
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    worker.postMessage(request, transfer);
  });
}
async function get(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load test asset: ${url}`);
  return response;
}

window.photoHarness = {
  async initialize(config) {
    const url = (id: string) => new URL(id, config.modelBaseUrl).href;
    const [detector, classifier, labels, taxonomy, geofence]: [
      ArrayBuffer,
      ArrayBuffer,
      string,
      string,
      unknown,
    ] = await Promise.all([
      get(url(config.detector)).then((response) => response.arrayBuffer()),
      get(url(config.classifier)).then((response) => response.arrayBuffer()),
      get(url(config.classifier_labels)).then((response) => response.text()),
      get(url(config.taxonomy)).then((response) => response.text()),
      get(url(config.geofence)).then((response) => response.json()),
    ]);
    if (!isGeofenceMap(geofence)) throw new Error('Invalid test geofence asset');
    const result = await send(
      {
        kind: 'init',
        models: { detector: new Uint8Array(detector), classifier: new Uint8Array(classifier) },
        labels: labels.trim().split(/\r?\n/),
        context: { taxonomyMap: loadTaxonomy(taxonomy), geofenceMap: geofence },
        baseUrl: new URL(import.meta.env.BASE_URL, location.origin).href,
        backend: config.backend,
        ...(config.detectorKind === undefined ? {} : { detector: config.detectorKind }),
      },
      [detector, classifier],
    );
    if (
      typeof result !== 'object' ||
      result === null ||
      !('backend' in result) ||
      (result.backend !== 'wasm' && result.backend !== 'webgpu')
    )
      throw new Error('Invalid initialization result');
    return { backend: result.backend };
  },
  async process(url, detections, settings = {}) {
    const blob = await (await get(url)).blob();
    const result = await send({
      file: new File([blob], new URL(url).pathname.split('/').pop() ?? 'photo.jpg', {
        type: 'image/jpeg',
      }),
      settings,
      ...(detections === undefined ? {} : { detections }),
    });
    if (
      typeof result !== 'object' ||
      result === null ||
      !('status' in result) ||
      (result.status !== 'ok' && result.status !== 'decode_failed')
    )
      throw new Error('Invalid photo result');
    return result;
  },
  close() {
    worker.terminate();
  },
};
