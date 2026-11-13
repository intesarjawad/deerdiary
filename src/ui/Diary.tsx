import type { ComponentChildren } from 'preact';
import { useMemo } from 'preact/hooks';
import type { NetworkSnapshot } from '../app/networkMeter';
import { activityLine, hourBins } from '../core/clock';
import { burstCounter, frameRank, sightingLabel } from '../core/events';
import { DEFAULT_INDEPENDENCE_INTERVAL_MIN, independentDetections } from '../core/independence';
import type { DeerdiaryEvent, IndependentDetection, PhotoResult } from '../core/types';
import { FoldPlate } from './FoldPlate';
import { Footer } from './Footer';
import { SpeciesCard, type SpeciesCardData } from './SpeciesCard';

const UNIDENTIFIED_KEY = 'unidentified-animal';
const UNIDENTIFIED_NAME = 'Unidentified animal';

function commonName(label: string): string {
  return label.split(';').at(-1) || label;
}

function scientificName(label: string): string | null {
  const parts = label.split(';');
  const [genus, epithet] = [parts[4], parts[5]];
  if (!genus) return null;
  return [genus.charAt(0).toUpperCase() + genus.slice(1), epithet].filter(Boolean).join(' ');
}

/** Only a label that names genus and species counts as a species in the headline. */
function namedToSpecies(label: string): boolean {
  const parts = label.split(';');
  return Boolean(parts[4] && parts[5]);
}

function speciesKey(label: string): string {
  return commonName(label) === 'animal' ? UNIDENTIFIED_KEY : label;
}

type Accumulator = {
  key: string;
  labels: Set<string>;
  events: Set<DeerdiaryEvent>;
  photoPaths: Set<string>;
  maxN: number;
  firstSeen: number | null;
  lastSeen: number | null;
  clockSuspect: boolean;
  bestPhoto: PhotoResult | null;
  bestRank: number;
};

function accumulator(key: string): Accumulator {
  return {
    key,
    labels: new Set(),
    events: new Set(),
    photoPaths: new Set(),
    maxN: 0,
    firstSeen: null,
    lastSeen: null,
    clockSuspect: false,
    bestPhoto: null,
    bestRank: Number.NEGATIVE_INFINITY,
  };
}

export type DiarySpeciesOptions = {
  intervalMin?: number | undefined;
  firstSightings?: readonly string[] | undefined;
};

/**
 * Groups every sighting into one card per label after folding each burst's broad labels into its
 * one specific animal, gives the detector's animal fallback its own card, and leaves blank, human
 * and vehicle detections for the footer.
 */
export function diarySpecies(
  events: readonly DeerdiaryEvent[],
  options: DiarySpeciesOptions = {},
): SpeciesCardData[] {
  const intervalMin = options.intervalMin ?? DEFAULT_INDEPENDENCE_INTERVAL_MIN;
  const firstSightings = new Set(options.firstSightings ?? []);
  const accumulators = new Map<string, Accumulator>();

  for (const event of events) {
    const counted = burstCounter(event.photos);
    for (const photo of event.photos) {
      const frameCounts = new Map<string, number>();
      for (const detection of photo.detections) {
        const label = counted(detection);
        if (label === undefined) continue;
        const key = speciesKey(label);
        let entry = accumulators.get(key);
        if (!entry) {
          entry = accumulator(key);
          accumulators.set(key, entry);
        }
        entry.labels.add(label);
        entry.events.add(event);
        entry.photoPaths.add(photo.path);
        if (photo.time.clockStatus === 'ok') {
          entry.firstSeen =
            entry.firstSeen === null
              ? photo.time.wallClockMs
              : Math.min(entry.firstSeen, photo.time.wallClockMs);
          entry.lastSeen =
            entry.lastSeen === null
              ? photo.time.wallClockMs
              : Math.max(entry.lastSeen, photo.time.wallClockMs);
        } else {
          entry.clockSuspect = true;
        }
        frameCounts.set(key, (frameCounts.get(key) ?? 0) + 1);
        const rank = frameRank(detection);
        if (entry.bestPhoto === null || rank > entry.bestRank) {
          entry.bestPhoto = photo;
          entry.bestRank = rank;
        }
      }
      for (const [key, frameCount] of frameCounts) {
        const entry = accumulators.get(key);
        if (entry) entry.maxN = Math.max(entry.maxN, frameCount);
      }
    }
  }

  const independent = new Map<string, Map<DeerdiaryEvent, IndependentDetection>>();
  for (const detection of independentDetections(events, intervalMin)) {
    const key = speciesKey(detection.label);
    if (!accumulators.has(key)) continue;
    let byEvent = independent.get(key);
    if (!byEvent) {
      byEvent = new Map();
      independent.set(key, byEvent);
    }
    const previous = byEvent.get(detection.event);
    if (!previous || detection.time.wallClockMs < previous.time.wallClockMs) {
      byEvent.set(detection.event, detection);
    }
  }

  return Array.from(accumulators.values())
    .map((entry): SpeciesCardData => {
      const labels = Array.from(entry.labels);
      const representative = labels[0] ?? entry.key;
      const unidentified = entry.key === UNIDENTIFIED_KEY;
      const evidence = independent.get(entry.key);
      const activityTimes = evidence
        ? Array.from(evidence.values())
            .filter((detection) => detection.time.clockStatus === 'ok')
            .map((detection) => detection.time.wallClockMs)
        : [];
      return {
        key: entry.key,
        name: unidentified ? UNIDENTIFIED_NAME : commonName(representative),
        scientificName: unidentified ? null : scientificName(representative),
        species: !unidentified && labels.some(namedToSpecies),
        labels,
        detections: evidence?.size ?? 0,
        photoCount: entry.photoPaths.size,
        maxN: entry.maxN,
        firstSeen: entry.firstSeen,
        lastSeen: entry.lastSeen,
        activity: activityLine(hourBins(activityTimes)),
        hours: hourBins(activityTimes),
        clockSuspect: entry.clockSuspect,
        firstSighting: !unidentified && labels.some((label) => firstSightings.has(label)),
        events: Array.from(entry.events),
        bestPhoto: entry.bestPhoto,
      };
    })
    .toSorted(
      (a, b) =>
        b.detections - a.detections || a.name.localeCompare(b.name) || a.key.localeCompare(b.key),
    );
}

export type DiaryPhotoCounts = {
  photoCount: number;
  blankPhotos: number;
  humanPhotos: number;
  vehiclePhotos: number;
};

/**
 * Counts each photo once per footer category, even when a frame holds several boxes. A photo is
 * blank only when nothing in it was counted: no sighting, person or vehicle.
 */
export function diaryPhotoCounts(events: readonly DeerdiaryEvent[]): DiaryPhotoCounts {
  const photos = new Set<string>();
  const blank = new Set<string>();
  const human = new Set<string>();
  const vehicle = new Set<string>();
  for (const event of events) {
    for (const photo of event.photos) {
      photos.add(photo.path);
      const names = new Set<string>();
      let sighted = false;
      for (const detection of photo.detections) {
        const label = detection.processed_classification?.class;
        if (label !== undefined) names.add(commonName(label));
        if (sightingLabel(detection) !== undefined) sighted = true;
      }
      if (!sighted && !names.has('human') && !names.has('vehicle')) blank.add(photo.path);
      if (names.has('human')) human.add(photo.path);
      if (names.has('vehicle')) vehicle.add(photo.path);
    }
  }
  return {
    photoCount: photos.size,
    blankPhotos: blank.size,
    humanPhotos: human.size,
    vehiclePhotos: vehicle.size,
  };
}

/** The box of the strongest counted detection of a species in its kept frame. */
function bestBox(
  photo: PhotoResult,
  labels: readonly string[],
  events: readonly DeerdiaryEvent[],
): [number, number, number, number] | undefined {
  const event = events.find((entry) => entry.photos.includes(photo));
  if (!event) return undefined;
  const counted = burstCounter(event.photos);
  const found = photo.detections
    .filter((detection) => {
      const label = counted(detection);
      return label !== undefined && labels.includes(label);
    })
    .toSorted((a, b) => frameRank(b) - frameRank(a))[0];
  return found && [...found.bbox];
}

/** The strip never draws more than this many tiles, however large the folder. */
export const ROLL_TILE_CAP = 240;

export type RollTile = {
  path: string;
  group: number;
  rank?: number;
  focus?: readonly [number, number, number, number];
};

/**
 * Every frame of the folder in shooting order, with the species pile it folds into and each
 * species' best frame numbered. A very large folder shows all kept frames and an even sample of
 * the rest, so the plate stays a plate.
 */
export function rollTiles(
  events: readonly DeerdiaryEvent[],
  cards: readonly SpeciesCardData[],
  cap: number = ROLL_TILE_CAP,
): RollTile[] {
  const ranks = new Map<string, number>();
  for (const [index, { bestPhoto }] of cards.entries()) {
    if (bestPhoto && !ranks.has(bestPhoto.path)) ranks.set(bestPhoto.path, index + 1);
  }
  const cardIndex = new Map(cards.map((card, index) => [card.key, index]));
  const groups = new Map<string, number>();
  const paths: string[] = [];
  for (const event of events) {
    const counted = burstCounter(event.photos);
    for (const photo of event.photos) {
      if (groups.has(photo.path)) continue;
      paths.push(photo.path);
      const strongest = photo.detections.toSorted((a, b) => b.conf - a.conf);
      let group = -1;
      for (const detection of strongest) {
        const label = counted(detection);
        if (label === undefined) continue;
        group = cardIndex.get(speciesKey(label)) ?? -1;
        break;
      }
      groups.set(photo.path, ranks.has(photo.path) ? (ranks.get(photo.path) ?? 1) - 1 : group);
    }
  }
  const tile = (path: string): RollTile => {
    const rank = ranks.get(path);
    const group = groups.get(path) ?? -1;
    if (rank === undefined) return { path, group };
    const card = cards[rank - 1];
    const focus = card?.bestPhoto ? bestBox(card.bestPhoto, card.labels, events) : undefined;
    return focus ? { path, group, rank, focus } : { path, group, rank };
  };
  if (paths.length <= cap) return paths.map(tile);
  const others = paths.filter((path) => !ranks.has(path));
  const room = Math.max(cap - ranks.size, 0);
  const sampled = new Set(
    Array.from({ length: room }, (_, index) => others[Math.floor((index * others.length) / room)]),
  );
  return paths.filter((path) => ranks.has(path) || sampled.has(path)).map(tile);
}

function Entry({ id, children }: { id: string; children: ComponentChildren }) {
  return (
    <li id={id} class="entry">
      {children}
    </li>
  );
}

export type DiaryProps = {
  events: readonly DeerdiaryEvent[];
  intervalMin?: number | undefined;
  firstSightings?: readonly string[] | undefined;
  thumbnailURL?: ((path: string) => string | undefined) | undefined;
  photoURL?: ((path: string) => string | undefined) | undefined;
  /** The original frame while the page still holds it; the portraits are cut from it. */
  originalURL?: ((path: string) => string | undefined) | undefined;
  /** True when the diary has no folder open, so its portraits can only come from previews. */
  originalsMissing?: boolean | undefined;
  onAddFolder?: (() => void) | undefined;
  /** All processed photos, including ones with no events; defaults to the event photos. */
  photoCount?: number | undefined;
  network?: NetworkSnapshot | undefined;
  sourceHref?: string | undefined;
};

/** The species diary: ranked cards over one card footer, fed by the pipeline's event signal. */
export function Diary({
  events,
  intervalMin,
  firstSightings,
  thumbnailURL,
  photoURL,
  originalURL,
  originalsMissing,
  onAddFolder,
  photoCount,
  network,
  sourceHref,
}: DiaryProps) {
  const cards = useMemo(
    () => diarySpecies(events, { intervalMin, firstSightings }),
    [events, intervalMin, firstSightings],
  );
  const counts = useMemo(() => diaryPhotoCounts(events), [events]);
  const tiles = useMemo(() => rollTiles(events, cards), [events, cards]);
  const frames = photoCount ?? counts.photoCount;

  function selectRank(rank: number) {
    const entry = document.getElementById(`species-${rank}`);
    if (!entry) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    entry.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    entry.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
  }

  return (
    <section class="diary" aria-label="Species diary">
      {cards.length === 0 ? (
        <p class="empty">No species found in these photos.</p>
      ) : (
        <>
          <FoldPlate
            tiles={tiles}
            groups={cards.map((card, index) => ({
              rank: index + 1,
              name: card.name,
              detections: card.detections,
              species: card.species,
            }))}
            frames={frames}
            thumbnailURL={thumbnailURL}
            photoURL={photoURL}
            originalURL={originalURL}
            originalsMissing={originalsMissing}
            onAddFolder={onAddFolder}
            onSelect={selectRank}
          />
          <ol class="ledger">
            {cards.map((species, row) => (
              <Entry key={species.key} id={`species-${row + 1}`}>
                <SpeciesCard species={species} thumbnailURL={thumbnailURL} photoURL={photoURL} />
              </Entry>
            ))}
          </ol>
        </>
      )}
      <Footer
        photoCount={frames}
        speciesCount={cards.filter((card) => card.species).length}
        blankPhotos={counts.blankPhotos}
        humanPhotos={counts.humanPhotos}
        vehiclePhotos={counts.vehiclePhotos}
        network={network}
        sourceHref={sourceHref}
      />
    </section>
  );
}
