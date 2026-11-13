import type { PhotoRequest, PhotoResult } from '../workers/photo';
import type { InitRequest, WorkerRequest, WorkerResponse } from '../workers/photo.worker';

export interface PhotoWorker {
  postMessage(request: WorkerRequest): void;
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  terminate(): void;
}

export class WorkerCrashed extends Error {}

/** Keeps one photo in flight so a failed worker can retry precisely that photo. */
export class PipelineWorker {
  private worker: PhotoWorker | undefined;
  private idleCrash: WorkerCrashed | undefined;
  private pending: { resolve(value: WorkerResponse): void; reject(error: Error): void } | undefined;

  constructor(
    private readonly create: () => PhotoWorker,
    private readonly init: InitRequest,
  ) {}

  private exchange(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.worker) {
      const error = this.idleCrash ?? new Error('Photo worker is unavailable');
      this.idleCrash = undefined;
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      try {
        this.worker?.postMessage(request);
      } catch (error) {
        this.pending = undefined;
        reject(error);
      }
    });
  }

  private async initialize() {
    const worker = this.create();
    this.worker = worker;
    worker.onmessage = ({ data }) => {
      if (worker !== this.worker || ('kind' in data && data.kind !== 'initialized')) return;
      const pending = this.pending;
      this.pending = undefined;
      if ('status' in data && data.status === 'inference_failed') {
        pending?.reject(new Error(data.reason));
      } else pending?.resolve(data);
    };
    worker.onerror = (event) => {
      if (worker !== this.worker) return;
      event.preventDefault();
      const crash = new WorkerCrashed(event.message);
      const idle = !this.pending;
      this.stop(crash);
      if (idle) this.idleCrash = crash;
    };
    await this.exchange(this.init);
  }

  async process(request: PhotoRequest): Promise<PhotoResult> {
    if (this.idleCrash) {
      const error = this.idleCrash;
      this.idleCrash = undefined;
      throw error;
    }
    if (!this.worker) await this.initialize();
    const response = await this.exchange(request);
    if (!('status' in response) || response.status === 'inference_failed') {
      throw new Error('Expected a processed photo from the photo worker');
    }
    return response;
  }

  stop(error = new Error('Photo processing stopped')): void {
    this.idleCrash = undefined;
    const pending = this.pending;
    this.pending = undefined;
    this.worker?.terminate();
    this.worker = undefined;
    pending?.reject(error);
  }
}
