import { batch, signal } from '@preact/signals';
import { groupEvents } from '../core/events';
import type { DeerdiaryEvent } from '../core/types';
import type { StoredResult } from '../storage/schema';
import type { Backend } from '../workers/photo';

export type Progress = {
  done: number;
  total: number;
  photosPerSecond: number;
  backend: Backend;
  secondsLeft: number | null;
};
export const STORAGE_FULL_NOTE =
  "Storage is full, so this card's results are kept in memory only and vanish on reload.";
export const PIPELINE_STOPPED_NOTE = 'Processing stopped twice on the same photo.';

/** Creates independent signals for a diary and its active processing session. */
export function createPipelineState() {
  const results = signal<readonly StoredResult[]>([]);
  const events = signal<readonly DeerdiaryEvent[]>([]);
  const progress = signal<Progress>({
    done: 0,
    total: 0,
    photosPerSecond: 0,
    backend: 'wasm',
    secondsLeft: null,
  });
  const storageNote = signal<string | null>(null);
  const failure = signal<{ message: string; href: string } | null>(null);
  return {
    results,
    events,
    progress,
    storageNote,
    failure,
    publish(stored: readonly StoredResult[], next: Progress, memoryOnly: boolean) {
      batch(() => {
        results.value = stored;
        events.value = groupEvents(
          stored.flatMap(({ output, time }) =>
            output.status === 'ok'
              ? [{ path: output.path, time, detections: output.detections }]
              : [],
          ),
        );
        progress.value = next;
        storageNote.value = memoryOnly ? STORAGE_FULL_NOTE : null;
      });
    },
  };
}
export type PipelineState = ReturnType<typeof createPipelineState>;
