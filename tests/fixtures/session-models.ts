import { signal } from '@preact/signals';
import type { ModelLoadState } from '../../src/app/photoModels';
import type { InitRequest } from '../../src/workers/photo.worker';

export function createPhotoModelLoader() {
  const state = signal<ModelLoadState>({ status: 'idle' });
  return {
    state,
    async init(): Promise<InitRequest> {
      state.value = {
        status: 'loading',
        progress: { fileRole: 'detector', receivedBytes: 0, totalBytes: 100 },
      };
      await new Promise<void>((resolve) =>
        addEventListener('models-ready', () => resolve(), { once: true }),
      );
      state.value = { status: 'ready' };
      return {
        kind: 'init',
        backend: 'wasm',
        baseUrl: location.origin,
        models: { detector: new Uint8Array(), classifier: new Uint8Array() },
        labels: [],
        context: { taxonomyMap: {}, geofenceMap: {} },
      };
    },
  };
}
export function modelDownloadText() {
  return 'Downloading the detector: 0 of 100 bytes.';
}
