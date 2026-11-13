import { observeResources, type ResourceMessage } from '../app/networkMeter';
import type { EnsembleContext } from '../core/labels';
import { type Backend, PhotoProcessor, type PhotoRequest, type PhotoResult } from './photo';
import type { DetectorKind, ModelBytes } from './photo-ort';

export type InitRequest = {
  kind: 'init';
  models: ModelBytes;
  labels: readonly string[];
  context: EnsembleContext;
  baseUrl: string;
  backend: Backend;
  detector?: DetectorKind;
};
export type WorkerRequest = InitRequest | PhotoRequest | { kind: 'echo'; value: string };
export type WorkerResponse =
  | PhotoResult
  | ResourceMessage
  | { kind: 'ready' | 'initialized'; backend: Backend; crossOriginIsolated: boolean }
  | { kind: 'echo'; value: string }
  | { status: 'inference_failed'; path?: string; reason: string };

observeResources((resources) => self.postMessage({ kind: 'network-resources', resources }));
self.postMessage({ kind: 'ready', backend: 'wasm', crossOriginIsolated: self.crossOriginIsolated });

let processor: PhotoProcessor | undefined;
let models: Awaited<ReturnType<typeof import('./photo-ort').createPhotoModels>> | undefined;
let queue = Promise.resolve();

async function receive(request: WorkerRequest) {
  if ('kind' in request) {
    switch (request.kind) {
      case 'echo':
        self.postMessage(request);
        return;
      case 'init': {
        if (
          request.labels.length !== 2498 ||
          request.labels.some((label) => label.split(';').length !== 7)
        )
          throw new Error('Expected 2498 SpeciesNet labels in model output order');
        const { createPhotoModels } = await import('./photo-ort');
        await models?.release();
        models = undefined;
        processor = undefined;
        models = await createPhotoModels(
          request.models,
          request.baseUrl,
          request.backend,
          request.detector,
        );
        processor = new PhotoProcessor(models, request.labels, request.context);
        self.postMessage({
          kind: 'initialized',
          backend: models.backend,
          crossOriginIsolated: self.crossOriginIsolated,
        });
        return;
      }
    }
  }
  if (!processor) throw new Error('Initialize photo models before sending a photo');
  self.postMessage(await processor.process(request));
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  queue = queue
    .then(() => receive(event.data))
    .catch((error: unknown) => {
      self.postMessage({
        status: 'inference_failed',
        ...('file' in event.data ? { path: event.data.settings.path ?? event.data.file.name } : {}),
        reason: error instanceof Error ? error.message : String(error),
      });
    });
};
