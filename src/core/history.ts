import type { Session, StoredResult } from '../storage/schema';
import { correctedEvents } from './corrections';
import { groupEvents } from './events';
import { DEFAULT_INDEPENDENCE_INTERVAL_MIN, independentDetections } from './independence';
import { Classification } from './labels';
import type { DeerdiaryEvent, PhotoResult } from './types';

/** One species in a diary, already carrying the name History shows. */
export type SessionSpecies = {
  /** The processed label after any correction; diaries are compared by this value. */
  label: string;
  /** The common name at the end of the label, which is what a person reads. */
  name: string;
  /** Independent detections, so a burst counts once however many frames it holds. */
  detections: number;
};

export type SessionSummary = {
  id: string;
  createdAtMs: number;
  dateRange: { first: number; last: number } | null;
  /** Photos with a stored result; a file that failed to decode is not a photo in the diary. */
  photoCount: number;
  species: readonly SessionSpecies[];
};

const NOT_SPECIES = new Set(['animal', 'unknown', 'blank', 'human', 'vehicle']);

function commonName(label: string): string {
  return label.split(';').at(-1) || label;
}

/** The detector's own fallbacks are not species a diary can list or announce as new. */
function isSpecies(label: string): boolean {
  return label !== Classification.UNKNOWN && !NOT_SPECIES.has(commonName(label));
}

/** Matches the key the export writes, so a correction saved from the diary applies here too. */
function correctionKey(event: DeerdiaryEvent, label: string): string {
  return `${event.cameraKey}@${event.photos[0]?.time.wallClockMs ?? 0}\u0000${label}`;
}

function sessionPhotos(
  session: Session,
  results: ReadonlyMap<string, StoredResult>,
): PhotoResult[] {
  const photos: PhotoResult[] = [];
  for (const key of session.fileKeys) {
    const stored = results.get(key);
    if (stored?.output.status !== 'ok') continue;
    const { output, time } = stored;
    photos.push({ path: output.path, time, detections: output.detections });
  }
  return photos;
}

function summarize(
  session: Session,
  results: ReadonlyMap<string, StoredResult>,
  corrections: Readonly<Record<string, string>>,
): SessionSummary {
  const photos = sessionPhotos(session, results);
  const counts = new Map<string, SessionSpecies>();
  const detections = independentDetections(
    correctedEvents(groupEvents(photos), corrections),
    DEFAULT_INDEPENDENCE_INTERVAL_MIN,
  );
  for (const detection of detections) {
    const label = detection.label;
    if (!isSpecies(label)) continue;
    const counted = counts.get(label);
    if (counted) counted.detections++;
    else counts.set(label, { label, name: commonName(label), detections: 1 });
  }
  return {
    id: session.id,
    createdAtMs: session.createdAtMs,
    dateRange: session.dateRange,
    photoCount: photos.length,
    species: Array.from(counts.values()),
  };
}

/** Lists each diary newest first with the photos and species the History view reports. */
export function sessionSummaries(
  sessions: readonly Session[],
  results: readonly StoredResult[],
  corrections: Readonly<Record<string, string>> = {},
): SessionSummary[] {
  const stored = new Map(results.map((result) => [result.key, result]));
  return sessions
    .map((session) => summarize(session, stored, corrections))
    .toSorted((a, b) => b.createdAtMs - a.createdAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Species in the current diary that no earlier diary already listed. Only diaries created before
 * the current one are compared, so a later drop never changes what was new at the time.
 */
export function firstSightings(
  sessions: readonly SessionSummary[],
  current: SessionSummary,
): readonly SessionSpecies[] {
  const seen = new Set<string>();
  for (const session of sessions) {
    if (session.createdAtMs >= current.createdAtMs) continue;
    for (const species of session.species) seen.add(species.label);
  }
  return current.species.filter((species) => isSpecies(species.label) && !seen.has(species.label));
}

/** The diary's events, as the export and the correction rows group them. */
export function sessionEvents(
  session: Session,
  results: readonly StoredResult[],
): DeerdiaryEvent[] {
  return groupEvents(
    sessionPhotos(session, new Map(results.map((result) => [result.key, result]))),
  );
}

/**
 * The saved corrections that apply to one diary. A correction is keyed by event and species, so it
 * belongs to every diary that holds that event.
 */
export function sessionCorrections(
  session: Session,
  results: readonly StoredResult[],
  corrections: Readonly<Record<string, string>>,
): Record<string, string> {
  const applied: Record<string, string> = {};
  for (const event of sessionEvents(session, results)) {
    for (const { label } of event.species) {
      const key = correctionKey(event, label);
      const value = corrections[key];
      if (value !== undefined) applied[key] = value;
    }
  }
  return applied;
}

/** Correction keys only this diary uses, so deleting it leaves another diary's corrections alone. */
export function exclusiveCorrectionKeys(
  session: Session,
  others: readonly Session[],
  results: readonly StoredResult[],
  corrections: Readonly<Record<string, string>>,
): string[] {
  const shared = new Set(
    others.flatMap((other) => Object.keys(sessionCorrections(other, results, corrections))),
  );
  return Object.keys(sessionCorrections(session, results, corrections)).filter(
    (key) => !shared.has(key),
  );
}
