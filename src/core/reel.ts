import { burstCounter } from './events';
import { DEFAULT_INDEPENDENCE_INTERVAL_MIN, independentDetections } from './independence';
import { wallClockDateRange } from './time';
import type { DeerdiaryEvent, Detection, PhotoResult } from './types';

export const REEL_SHOT_MS = 1200;
export const REEL_CROSSFADE_MS = 300;
export const REEL_SCALE_DRIFT = 0.04;
export const REEL_END_CARD_MS = 2000;
export const REEL_SHOTS = 8;
export const REEL_TOP_SPECIES = 3;

const NOT_SPECIES = new Set(['animal', 'blank', 'human', 'no cv result', 'unknown', 'vehicle']);

export type ReelShot = {
  event: DeerdiaryEvent;
  photo: PhotoResult;
  label: string;
  /** Detection confidence, classifier score and visible box area multiplied together. */
  rank: number;
  /** Independent detections of this label in the whole diary. */
  independent: number;
  /** The ranked detection's box, which the on-page player frames. */
  box: readonly number[];
};

export type ReelSpecies = { label: string; name: string; detections: number };

export type ReelProject = { name: string; pagesUrl?: string | undefined };

export type ReelEndCard = {
  species: readonly ReelSpecies[];
  dateRange: { first: number; last: number } | null;
  projectName: string;
  pagesUrl: string | null;
};

export function commonName(label: string): string {
  return label.split(';').at(-1) || label;
}

function isSpecies(label: string): boolean {
  return !NOT_SPECIES.has(commonName(label));
}

function detectionRank(detection: Detection): number {
  return (
    detection.conf *
    (detection.processed_classification?.score ?? 0) *
    detection.bbox[2] *
    detection.bbox[3]
  );
}

function bestDetection(
  event: DeerdiaryEvent,
  label: string,
): { photo: PhotoResult; rank: number; box: readonly number[] } | undefined {
  const counted = burstCounter(event.photos);
  let best: { photo: PhotoResult; rank: number; box: readonly number[] } | undefined;
  for (const photo of event.photos) {
    for (const detection of photo.detections) {
      if (counted(detection) !== label) continue;
      const rank = detectionRank(detection);
      if (best === undefined || rank > best.rank) best = { photo, rank, box: detection.bbox };
    }
  }
  return best;
}

function independentCounts(events: readonly DeerdiaryEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const detection of independentDetections(events, DEFAULT_INDEPENDENCE_INTERVAL_MIN)) {
    counts.set(detection.label, (counts.get(detection.label) ?? 0) + 1);
  }
  return counts;
}

function shotForEvent(
  event: DeerdiaryEvent,
  counts: ReadonlyMap<string, number>,
): ReelShot | undefined {
  let best: ReelShot | undefined;
  for (const { label } of event.species) {
    if (!isSpecies(label)) continue;
    const detection = bestDetection(event, label);
    if (!detection) continue;
    const independent = counts.get(label) ?? 0;
    const candidate = { event, ...detection, label, independent };
    if (
      best === undefined ||
      independent > best.independent ||
      (independent === best.independent && candidate.rank > best.rank)
    ) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Picks one well-framed shot per burst, favouring the species the diary counts most independently.
 * Bursts holding only detector fallbacks, blank frames, people or vehicles have no shot.
 */
export function rankForReel(events: readonly DeerdiaryEvent[], n = REEL_SHOTS): ReelShot[] {
  const counts = independentCounts(events);
  const shots: ReelShot[] = [];
  for (const event of events) {
    const shot = shotForEvent(event, counts);
    if (shot) shots.push(shot);
  }
  return shots
    .toSorted(
      (a, b) =>
        b.independent - a.independent ||
        b.rank - a.rank ||
        a.photo.time.wallClockMs - b.photo.time.wallClockMs ||
        a.label.localeCompare(b.label) ||
        a.event.cameraKey.localeCompare(b.event.cameraKey),
    )
    .slice(0, Math.max(0, Math.floor(n)));
}

/** The top species and dates shown after the last shot. */
export function reelEndCard(events: readonly DeerdiaryEvent[], project: ReelProject): ReelEndCard {
  const species = Array.from(independentCounts(events), ([label, detections]) => ({
    label,
    name: commonName(label),
    detections,
  }))
    .filter((entry) => isSpecies(entry.label))
    .toSorted(
      (a, b) =>
        b.detections - a.detections ||
        a.name.localeCompare(b.name) ||
        a.label.localeCompare(b.label),
    )
    .slice(0, REEL_TOP_SPECIES);

  return {
    species,
    dateRange: wallClockDateRange(
      events.flatMap((event) => event.photos.map((photo) => photo.time)),
    ),
    projectName: project.name,
    pagesUrl: project.pagesUrl ?? null,
  };
}

/** Total playback time of the chosen shots and the optional end card. */
export function reelDurationMs(shotCount: number, includeEndCard: boolean): number {
  return shotCount * REEL_SHOT_MS + (includeEndCard ? REEL_END_CARD_MS : 0);
}

export const REEL_WIDTH = 1280;
export const REEL_HEIGHT = 720;
// Thirty frames a second divides a shot, the crossfade and the card into whole frames.
export const REEL_FRAME_RATE = 30;

export type ReelSlide = { kind: 'shot'; index: number } | { kind: 'end' };

export type ReelLayer = { slide: ReelSlide; opacity: number; scale: number };

export function reelFrameCount(durationMs: number): number {
  return Math.round((durationMs * REEL_FRAME_RATE) / 1000);
}

function driftScale(elapsedMs: number): number {
  return 1 + REEL_SCALE_DRIFT * Math.min(1, elapsedMs / REEL_SHOT_MS);
}

/**
 * What the exported frame at `timeMs` shows, bottom layer first. Each slide after the first fades
 * in over the previous one, which holds its final scale; the end card does not drift.
 */
export function reelLayers(
  timeMs: number,
  shotCount: number,
  includeEndCard: boolean,
): ReelLayer[] {
  if (shotCount <= 0) return [];
  const time = Math.min(Math.max(timeMs, 0), reelDurationMs(shotCount, includeEndCard));
  const lastSlot = includeEndCard ? shotCount : shotCount - 1;
  const slot = Math.min(Math.floor(time / REEL_SHOT_MS), lastSlot);
  const elapsedMs = time - slot * REEL_SHOT_MS;
  const top: ReelLayer = {
    slide: slot < shotCount ? { kind: 'shot', index: slot } : { kind: 'end' },
    opacity: slot === 0 ? 1 : Math.min(1, elapsedMs / REEL_CROSSFADE_MS),
    scale: slot < shotCount ? driftScale(elapsedMs) : 1,
  };
  if (top.opacity === 1) return [top];
  return [
    { slide: { kind: 'shot', index: slot - 1 }, opacity: 1, scale: driftScale(REEL_SHOT_MS) },
    top,
  ];
}
