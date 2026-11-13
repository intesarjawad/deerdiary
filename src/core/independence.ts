import { burstCounter } from './events';
import type { DeerdiaryEvent, IndependentDetection } from './types';

// Common convention in camera-trap activity analyses.
export const DEFAULT_INDEPENDENCE_INTERVAL_MIN = 30;
const MILLISECONDS_PER_MINUTE = 60_000;

/** Counts each species per camera relative to its previous counted sighting. */
export function independentDetections(
  events: readonly DeerdiaryEvent[],
  intervalMin: number,
): IndependentDetection[] {
  const candidates: IndependentDetection[] = [];
  for (const event of events) {
    const counted = burstCounter(event.photos);
    for (const { label } of event.species) {
      // A species may first appear after the frame that starts a mixed-species burst.
      const firstPhoto = event.photos.find((photo) =>
        photo.detections.some((detection) => counted(detection) === label),
      );
      if (firstPhoto)
        candidates.push({ cameraKey: event.cameraKey, label, time: firstPhoto.time, event });
    }
  }
  candidates.sort((a, b) => a.time.wallClockMs - b.time.wallClockMs);
  const previousByCamera = new Map<string, Map<string, number>>();
  const counted: IndependentDetection[] = [];
  for (const candidate of candidates) {
    let previousBySpecies = previousByCamera.get(candidate.cameraKey);
    if (!previousBySpecies) {
      previousBySpecies = new Map();
      previousByCamera.set(candidate.cameraKey, previousBySpecies);
    }
    const previous = previousBySpecies.get(candidate.label);
    if (
      previous === undefined ||
      candidate.time.wallClockMs - previous > intervalMin * MILLISECONDS_PER_MINUTE
    ) {
      counted.push(candidate);
      previousBySpecies.set(candidate.label, candidate.time.wallClockMs);
    }
  }
  return counted;
}
