import { intersectionOverSmaller } from './nms';
import type { DeerdiaryEvent, Detection, PhotoResult } from './types';

// Trail cameras fire 1 to 10 shots per trigger; 60 s separates triggers.
export const BURST_GAP_MS = 60_000;
// Upstream's mid-confidence animal threshold: boxes at 0.1 to 0.2 are classified but too often
// spurious to count, in MaxN or anywhere else in the diary.
export const MAXN_MIN_CONF = 0.2;
// The default detector is NMS-free and also boxes parts of an animal, such as the body inside the
// body-and-tail box. A part's IoU with the whole is low because the whole is larger, so what marks
// it is how much of it lies inside: 98 % or more for every part box on the sample (ADR 0005).
export const SAME_ANIMAL_ENCLOSED_SHARE = 0.9;
// "no cv result" is the ensemble's unknown: it declined to call the box an animal (ADR 0005).
const NOT_SIGHTINGS = new Set(['blank', 'human', 'vehicle', 'no cv result']);

/** The processed label a detection adds to the diary, or undefined when it is not a sighting. */
export function sightingLabel(detection: Detection): string | undefined {
  const label = detection.processed_classification?.class;
  if (label === undefined || detection.conf < MAXN_MIN_CONF) return undefined;
  return NOT_SIGHTINGS.has(label.split(';').at(-1) ?? '') ? undefined : label;
}

// Label fields are id;class;order;family;genus;species;common name.
function taxonomy(label: string): readonly string[] {
  return label.split(';').slice(1, 6);
}

/** True when `broad` names a group containing `specific`; the animal fallback contains every taxon. */
function isAncestor(broad: string, specific: string): boolean {
  const outer = taxonomy(broad);
  const inner = taxonomy(specific);
  return (
    outer.length === 5 &&
    inner.length === 5 &&
    outer.every((level, index) => level === '' || level === inner[index]) &&
    inner.some((level, index) => level !== '' && (outer[index] ?? '') === '')
  );
}

/**
 * Within one burst, a broad label whose narrower labels all lie on one line of descent is the
 * same animal seen less clearly, so it counts as the most specific of them. A broad label that
 * could belong to two different animals in the burst keeps its own count (ADR 0005).
 */
export function burstFolds(photos: readonly PhotoResult[]): ReadonlyMap<string, string> {
  const labels = new Set<string>();
  for (const photo of photos) {
    for (const detection of photo.detections) {
      const label = sightingLabel(detection);
      if (label !== undefined) labels.add(label);
    }
  }
  const folds = new Map<string, string>();
  for (const broad of labels) {
    const narrower = [...labels].filter((label) => isAncestor(broad, label));
    const leaves = narrower.filter((label) => !narrower.some((other) => isAncestor(label, other)));
    const [leaf] = leaves;
    if (leaf !== undefined && leaves.length === 1) folds.set(broad, leaf);
  }
  return folds;
}

/**
 * The label each detection of a burst counts as, or undefined when it is not a sighting or repeats
 * a more confident box of the same animal in its frame. Every count shown to a person reads this;
 * stored results and per-box exports keep each box's own label.
 */
export function burstCounter(
  photos: readonly PhotoResult[],
): (detection: Detection) => string | undefined {
  const folds = burstFolds(photos);
  const countedAs = (detection: Detection) => {
    const label = sightingLabel(detection);
    return label === undefined ? undefined : (folds.get(label) ?? label);
  };
  const repeats = new Set<Detection>();
  for (const photo of photos) {
    const kept: { bbox: Detection['bbox']; label: string }[] = [];
    for (const detection of photo.detections.toSorted((a, b) => b.conf - a.conf)) {
      const label = countedAs(detection);
      if (label === undefined) continue;
      const repeat = kept.some(
        (other) =>
          other.label === label &&
          intersectionOverSmaller(other.bbox, detection.bbox) >= SAME_ANIMAL_ENCLOSED_SHARE,
      );
      if (repeat) repeats.add(detection);
      else kept.push({ bbox: detection.bbox, label });
    }
  }
  return (detection) => (repeats.has(detection) ? undefined : countedAs(detection));
}

/** Merges numbered DCF folders under their parent without merging separate cameras. */
export function cameraKey(path: string): string {
  const folders = path.split('/').slice(0, -1);
  if (/^\d{3}[A-Z0-9_]{5}$/.test(folders.at(-1) ?? '')) folders.pop();
  return folders.join('/');
}

const EDGE_MARGIN = 0.01;
// A box cut off by the frame edge is usually glare, a partial body or a tail; it only wins when
// no complete box of the same animal exists.
const CLIPPED_FACTOR = 0.1;
// Past this share of the frame a box is a fur close-up, not a portrait.
const CLOSE_UP_AREA = 0.25;

/**
 * Ranks a detection as the frame to show for its animal: how sure the detector and classifier are,
 * scaled by the square root of the box area so a large box helps, demoted when the box is a close-up
 * of fur, sits far from the centre, or touches the frame edge.
 */
export function frameRank(detection: Detection): number {
  const [x, y, w, h] = detection.bbox;
  const clipped =
    x <= EDGE_MARGIN || y <= EDGE_MARGIN || x + w >= 1 - EDGE_MARGIN || y + h >= 1 - EDGE_MARGIN;
  const score = detection.processed_classification?.score ?? 0;
  const area = w * h;
  const fill = area > CLOSE_UP_AREA ? CLOSE_UP_AREA / area : 1;
  const offCentre = Math.hypot(x + w / 2 - 0.5, y + h / 2 - 0.5) / Math.SQRT1_2;
  const centred = 1 - 0.4 * Math.min(offCentre, 1);
  return (
    detection.conf *
    score *
    Math.sqrt(Math.min(area, CLOSE_UP_AREA)) *
    fill *
    centred *
    (clipped ? CLIPPED_FACTOR : 1)
  );
}

function eventSpecies(photos: readonly PhotoResult[]): DeerdiaryEvent['species'] {
  const counted = burstCounter(photos);
  const best = new Map<string, { bestPhoto: PhotoResult; rank: number }>();
  for (const photo of photos) {
    for (const detection of photo.detections) {
      const label = counted(detection);
      if (label === undefined) continue;
      const rank = frameRank(detection);
      const previous = best.get(label);
      if (!previous || rank > previous.rank) best.set(label, { bestPhoto: photo, rank });
    }
  }
  return Array.from(best, ([label, { bestPhoto }]) => ({ label, bestPhoto }));
}

/** Groups adjacent camera readings into bursts without mutating the input. */
export function groupEvents(
  photos: readonly PhotoResult[],
  gapMs = BURST_GAP_MS,
): DeerdiaryEvent[] {
  const ordered = photos.toSorted((a, b) => {
    const timeDifference = a.time.wallClockMs - b.time.wallClockMs;
    return timeDifference || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  });
  const bursts: { cameraKey: string; photos: PhotoResult[] }[] = [];
  const lastByCamera = new Map<string, (typeof bursts)[number]>();
  for (const photo of ordered) {
    const key = cameraKey(photo.path);
    const previous = lastByCamera.get(key);
    const lastPhoto = previous?.photos.at(-1);
    if (previous && lastPhoto && photo.time.wallClockMs - lastPhoto.time.wallClockMs < gapMs) {
      previous.photos.push(photo);
    } else {
      const burst = { cameraKey: key, photos: [photo] };
      bursts.push(burst);
      lastByCamera.set(key, burst);
    }
  }
  return bursts.map((burst) => ({ ...burst, species: eventSpecies(burst.photos) }));
}

/** Returns the most boxes counted as `label` in any one frame. */
export function maxN(event: DeerdiaryEvent, label: string): number {
  const counted = burstCounter(event.photos);
  let maximum = 0;
  for (const photo of event.photos) {
    const count = photo.detections.filter((detection) => counted(detection) === label).length;
    maximum = Math.max(maximum, count);
  }
  return maximum;
}
