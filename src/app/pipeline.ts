import { combine } from '../core/ensemble';
import { wallClockDateRange } from '../core/time';
import { readCameraTime } from '../files/exif';
import type { ScannedFile } from '../files/scan';
import { videoCameraTime } from '../files/video';
import {
  fileKey,
  type Location,
  type PipelineStorage,
  type Session,
  type StoredResult,
} from '../storage/schema';
import type { PhotoResult } from '../workers/photo';
import type { InitRequest } from '../workers/photo.worker';
import { type ClipFrames, clipFrameFiles, mergeClipFrames, skippedClip } from './clips';
import { isResourceMessage, type NetworkMeter } from './networkMeter';
import { type PhotoWorker, PipelineWorker, WorkerCrashed } from './pipelineWorker';
import { createPipelineState, PIPELINE_STOPPED_NOTE, type PipelineState } from './state';

export const READ_AHEAD = 4;
export const RESULT_BATCH_SIZE = 50;
export const FLUSH_INTERVAL_MS = 2_000;
export const RATE_WINDOW = 20;
const RATE_ALPHA = 2 / (RATE_WINDOW + 1);

type PipelineOptions = {
  storage: PipelineStorage;
  init: InitRequest;
  createWorker?: () => PhotoWorker;
  state?: PipelineState;
  now?: () => number;
  readTime?: typeof readCameraTime;
  clipFrames?: (file: File) => Promise<ClipFrames>;
};

/** Coordinates serial inference, bounded intake, durable batches and geographic reruns. */
export class PhotoPipeline {
  readonly state: PipelineState;
  private readonly worker: PipelineWorker;
  private readonly now: () => number;
  private readonly readTime: typeof readCameraTime;
  private readonly clipFrames: (file: File) => Promise<ClipFrames>;
  private readonly results = new Map<string, StoredResult>();
  private pending: StoredResult[] = [];
  private session: Session | undefined;
  private location: Location;
  private rate = 0;
  private running = false;
  private serial = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: PipelineOptions) {
    this.state = options.state ?? createPipelineState();
    this.worker = new PipelineWorker(options.createWorker ?? createPhotoWorker, options.init);
    this.now = options.now ?? (() => performance.now());
    this.readTime = options.readTime ?? readCameraTime;
    this.clipFrames = options.clipFrames ?? clipFrameFiles;
    this.location = {
      ...(options.init.context.country ? { country: options.init.context.country } : {}),
      ...(options.init.context.admin1Region
        ? { admin1Region: options.init.context.admin1Region }
        : {}),
    };
  }

  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const next = this.serial.then(action);
    // A caller receives each failure; subsequent requests must still be able to run.
    this.serial = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  /**
   * Relabels the classified boxes and drops the rest: nothing draws, counts or relabels a box the
   * classifier never saw, and the default detector returns 300 per photo.
   */
  private ensemble(output: PhotoResult): PhotoResult {
    if (output.status !== 'ok') return output;
    return {
      ...output,
      detections: output.detections.flatMap((detection) =>
        detection.raw_classifications
          ? [
              {
                ...detection,
                processed_classification: combine(detection, detection.raw_classifications, {
                  ...this.options.init.context,
                  country: this.location.country,
                  admin1Region: this.location.admin1Region,
                }),
              },
            ]
          : [],
      ),
    };
  }

  private publish() {
    const remaining = (this.session?.fileKeys.length ?? 0) - this.results.size;
    this.state.publish(
      Array.from(this.results.values()),
      {
        done: this.results.size,
        total: this.session?.fileKeys.length ?? 0,
        photosPerSecond: this.rate,
        backend: this.state.progress.value.backend,
        secondsLeft: remaining === 0 ? 0 : this.rate > 0 ? remaining / this.rate : null,
      },
      this.options.storage.memoryOnly,
    );
  }

  private async flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.session) return;
    this.session.dateRange = wallClockDateRange(
      Array.from(this.results.values(), (value) => value.time),
    );
    while (this.pending.length > 0) {
      const results = this.pending.slice(0, RESULT_BATCH_SIZE);
      await this.options.storage.saveBatch({ files: [], results, session: this.session });
      this.pending.splice(0, results.length);
    }
    this.publish();
  }

  /** Saves the selection and recombines raw outputs without sending worker messages. */
  setLocation(location: Location): Promise<void> {
    return this.mutate(async () => {
      await this.options.storage.saveLocation(location);
      this.location = { ...location };
      for (const [key, result] of this.results) {
        this.results.set(key, { ...result, output: this.ensemble(result.output) });
      }
      this.pending = Array.from(this.results.values());
      await this.flush();
    });
  }

  /** Starts one drop; unchanged completed files are restored before the worker is created. */
  async run(
    scanned: readonly ScannedFile[],
    session: Pick<Session, 'id' | 'createdAtMs'>,
    dropWallClockMs: number,
  ): Promise<void> {
    if (this.running) throw new Error('A photo session is already running');
    this.running = true;
    let backgroundError: unknown;
    let respawned = false;
    const files = Array.from(
      new Map(
        scanned
          .filter((file) => file.kind === 'photo' || file.kind === 'video')
          .map((file) => [fileKey(file), file]),
      ).values(),
    );
    try {
      await this.mutate(async () => {
        this.results.clear();
        this.pending = [];
        this.rate = 0;
        this.state.failure.value = null;
        this.state.progress.value = {
          done: 0,
          total: files.length,
          photosPerSecond: 0,
          secondsLeft: null,
          backend: this.options.init.backend,
        };
        this.location = (await this.options.storage.loadLocation()) ?? this.location;
        this.session = { ...session, fileKeys: files.map(fileKey), dateRange: null };
        for (const result of await this.options.storage.loadResults(this.session.fileKeys)) {
          this.results.set(result.key, { ...result, output: this.ensemble(result.output) });
          this.state.progress.value = {
            ...this.state.progress.value,
            backend: result.output.backend,
          };
        }
        this.session.dateRange = wallClockDateRange(
          Array.from(this.results.values(), (value) => value.time),
        );
        await this.options.storage.saveBatch({
          files: files.map((file) => ({
            key: fileKey(file),
            path: file.path,
            sizeBytes: file.sizeBytes,
            mtimeMs: file.mtimeMs,
          })),
          results: [],
          session: this.session,
        });
        this.pending = Array.from(this.results.values());
        await this.flush();
      });
      const queue = files.filter((file) => !this.results.has(fileKey(file)));
      const prepare = async (scanned: ScannedFile) => {
        try {
          const file =
            'getFile' in scanned.source ? await scanned.source.getFile() : scanned.source;
          return {
            scanned,
            file,
            time:
              scanned.kind === 'video'
                ? videoCameraTime(scanned, dropWallClockMs)
                : await this.readTime({ ...scanned, source: file }, dropWallClockMs),
          };
        } catch (error) {
          return { error };
        }
      };
      const infer = async (file: File, path: string): Promise<PhotoResult> => {
        while (true) {
          try {
            return await this.worker.process({ file, settings: { path } });
          } catch (error) {
            if (!(error instanceof WorkerCrashed)) throw error;
            if (respawned) {
              this.state.failure.value = {
                message: PIPELINE_STOPPED_NOTE,
                href: 'docs/local-pipeline.md',
              };
              throw error;
            }
            respawned = true;
          }
        }
      };
      // Frames are sampled only when their clip's turn comes, so read-ahead never holds them.
      const inferClip = async (file: File, path: string): Promise<PhotoResult> => {
        const clip = await this.clipFrames(file);
        if (clip.status !== 'ok') return skippedClip(path, this.state.progress.value.backend, clip);
        const outputs: PhotoResult[] = [];
        for (const frame of clip.frames) outputs.push(this.ensemble(await infer(frame, path)));
        // shortcut: a country change relabels only the kept boxes, so store every frame if MaxN must follow it.
        return mergeClipFrames(path, outputs);
      };
      const ahead = queue.splice(0, READ_AHEAD).map(prepare);
      while (ahead.length > 0) {
        const prepared = await ahead[0];
        if (!prepared) throw new Error('Missing queued photo');
        if ('error' in prepared) throw prepared.error;
        if (backgroundError) throw backgroundError;
        const start = this.now();
        const { path } = prepared.scanned;
        const output =
          prepared.scanned.kind === 'video'
            ? await inferClip(prepared.file, path)
            : await infer(prepared.file, path);
        await this.mutate(async () => {
          const duration = this.now() - start;
          if (duration > 0) {
            const sample = 1_000 / duration;
            this.rate =
              this.rate === 0 ? sample : RATE_ALPHA * sample + (1 - RATE_ALPHA) * this.rate;
          }
          const result = {
            key: fileKey(prepared.scanned),
            time: prepared.time,
            output: this.ensemble(output),
          };
          this.results.set(result.key, result);
          this.pending.push(result);
          this.state.progress.value = { ...this.state.progress.value, backend: output.backend };
          this.publishProgress();
          if (this.pending.length >= RESULT_BATCH_SIZE) await this.flush();
          else if (!this.timer)
            this.timer = setTimeout(() => {
              void this.mutate(() => this.flush()).catch((error: unknown) => {
                backgroundError = error;
                this.worker.stop(error instanceof Error ? error : new Error(String(error)));
              });
            }, FLUSH_INTERVAL_MS);
        });
        // Already awaited above; the slot is only being freed.
        void ahead.shift();
        const next = queue.shift();
        if (next) ahead.push(prepare(next));
      }
      if (backgroundError) throw backgroundError;
    } finally {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.worker.stop();
      try {
        await this.mutate(() => this.flush());
      } finally {
        this.running = false;
      }
    }
  }

  private publishProgress() {
    const total = this.session?.fileKeys.length ?? 0;
    this.state.progress.value = {
      ...this.state.progress.value,
      done: this.results.size,
      total,
      photosPerSecond: this.rate,
      secondsLeft:
        total === this.results.size
          ? 0
          : this.rate > 0
            ? (total - this.results.size) / this.rate
            : null,
    };
  }
}

/** Starts the photo pipeline in a dedicated module worker. */
export function createPhotoWorker(meter?: NetworkMeter): Worker {
  const worker = new Worker(new URL('../workers/photo.worker.ts', import.meta.url), {
    type: 'module',
  });
  if (meter) {
    worker.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (isResourceMessage(event.data)) meter.record(event.data.resources);
    });
  }
  return worker;
}
