import { burstFolds, groupEvents } from './events';
import type { DeerdiaryEvent, Detection } from './types';

/** Identifies a burst consistently across views, corrections and exports. */
export function eventId(event: DeerdiaryEvent): string {
  return `${event.cameraKey}@${event.photos[0]?.time.wallClockMs ?? 0}`;
}

/** A replacement belongs to one species in one burst. */
export function correctionKey(event: string, label: string): string {
  return `${event}\u0000${label}`;
}

/** Applies a burst's replacement to every matching box, including broad labels folded into it. */
export function correctDetection<T extends Detection>(
  detection: T,
  event: DeerdiaryEvent,
  corrections: Readonly<Record<string, string>>,
  folds = burstFolds(event.photos),
): T {
  const processed = detection.processed_classification;
  if (processed === undefined) return detection;
  const label = folds.get(processed.class) ?? processed.class;
  const replacement = corrections[correctionKey(eventId(event), label)];
  return replacement === undefined
    ? detection
    : { ...detection, processed_classification: { class: replacement, score: 1, source: 'human' } };
}

/** Rebuilds counts and best photos from corrected boxes without changing stored machine results. */
export function correctedEvents(
  events: readonly DeerdiaryEvent[],
  corrections: Readonly<Record<string, string>>,
): DeerdiaryEvent[] {
  return events.flatMap((event) => {
    const folds = burstFolds(event.photos);
    return groupEvents(
      event.photos.map((photo) => ({
        ...photo,
        detections: photo.detections.map((detection) =>
          correctDetection(detection, event, corrections, folds),
        ),
      })),
    );
  });
}
