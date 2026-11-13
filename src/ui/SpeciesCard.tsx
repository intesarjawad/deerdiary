import { useId } from 'preact/hooks';
import type { ActivityLine } from '../core/clock';
import type { DeerdiaryEvent, PhotoResult } from '../core/types';
import { DetectionBoxes, EventGrid, formatCameraTime } from './EventGrid';

const count = new Intl.NumberFormat('en-US');

export type SpeciesCardData = {
  key: string;
  name: string;
  scientificName: string | null;
  /** True when a label names genus and species, so the headline may count it as a species. */
  species: boolean;
  labels: readonly string[];
  detections: number;
  photoCount: number;
  maxN: number;
  firstSeen: number | null;
  lastSeen: number | null;
  activity: ActivityLine;
  /** Independent detections per camera hour, midnight first. */
  hours: readonly number[];
  clockSuspect: boolean;
  firstSighting: boolean;
  events: readonly DeerdiaryEvent[];
  bestPhoto: PhotoResult | null;
};

/**
 * The counts the diary and the landing sheet both print: kinds named to species, and detections
 * whose label stops above species, each of which leaves its own blank on the sheet.
 */
export function labelCounts(labels: readonly Pick<SpeciesCardData, 'species' | 'detections'>[]) {
  return {
    named: labels.filter(({ species }) => species).length,
    broader: labels.reduce((sum, { species, detections }) => sum + (species ? 0 : detections), 0),
  };
}

export type SpeciesCardProps = {
  species: SpeciesCardData;
  thumbnailURL?: ((path: string) => string | undefined) | undefined;
  photoURL?: ((path: string) => string | undefined) | undefined;
};

function hourLabel(hour: number): string {
  if (hour === 0) return '12 am';
  if (hour === 12) return '12 pm';
  return hour < 12 ? `${hour} am` : `${hour - 12} pm`;
}

/** The rule only names a peak when the window and the count make it meaningful. */
export function formatActivity(line: ActivityLine): string | null {
  if (line.kind === 'none') return null;
  if (line.kind === 'allHours') return 'seen at all hours';
  const start = hourLabel(line.startHour);
  return line.startHour === line.endHour
    ? `mostly ${start}`
    : `mostly ${start} to ${hourLabel(line.endHour)}`;
}

function photosLabel(value: number): string {
  return `${count.format(value)} ${value === 1 ? 'photo' : 'photos'}`;
}

const HOUR_TICKS = [0, 6, 12, 18] as const;

/** Twenty-four bars, one per camera hour, so a species' habits read at a glance. */
function HourBars({ hours }: { hours: readonly number[] }) {
  const max = Math.max(...hours, 1);
  return (
    <div class="hours" role="img" aria-label="Independent detections by camera hour">
      <div class="hours-bars" aria-hidden="true">
        {hours.map((value, hour) => (
          <span
            key={hour}
            class={value > 0 ? 'hour on' : 'hour'}
            style={{ height: `${(value / max) * 100}%` }}
          />
        ))}
      </div>
      <div class="hours-ticks" aria-hidden="true">
        {HOUR_TICKS.map((hour) => (
          <span key={hour}>{hourLabel(hour)}</span>
        ))}
      </div>
    </div>
  );
}

/** One species in the diary, newest events reachable from the card's thumbnail grid. */
export function SpeciesCard({ species, thumbnailURL, photoURL }: SpeciesCardProps) {
  const heading = useId();
  const activity = formatActivity(species.activity);
  const bestPhoto = species.bestPhoto;
  const bestEvent = species.events.find((event) => bestPhoto && event.photos.includes(bestPhoto));
  const thumbnail = bestPhoto ? thumbnailURL?.(bestPhoto.path) : undefined;

  const hasFrame = bestPhoto && bestEvent && thumbnail;
  // A species seen once has no spread of hours or dates to show, so its entry is the short form.
  const once = species.detections === 1 && species.firstSeen === species.lastSeen;

  return (
    <article
      class={['species', hasFrame ? '' : 'no-frame', once ? 'once' : ''].join(' ').trim()}
      aria-labelledby={heading}
    >
      {hasFrame && (
        <div class="species-frame">
          <span class="frame">
            <img
              src={thumbnail}
              alt={`${species.name} at ${formatCameraTime(bestPhoto.time.wallClockMs)}`}
            />
            <DetectionBoxes photo={bestPhoto} event={bestEvent} labels={species.labels} />
          </span>
        </div>
      )}
      <header>
        <h2 id={heading} tabIndex={-1}>
          {species.name}
        </h2>
        {species.scientificName && <p class="latin">{species.scientificName}</p>}
        {species.firstSighting && <p class="badge first">First time in your diaries</p>}
        {species.clockSuspect && <p class="badge">camera clock not set</p>}
        <div class="tally">
          <p class="tally-line">
            <span class="tally-number">{count.format(species.detections)}</span>
            <span class="tally-unit">
              {' '}
              independent {species.detections === 1 ? 'detection' : 'detections'}
            </span>
            <span class="tally-unit"> · {photosLabel(species.photoCount)}</span>
            <span class="tally-unit"> · up to {count.format(species.maxN)} at once</span>
          </p>
        </div>
        {once && species.firstSeen !== null && (
          <p class="facts">Seen once, {formatCameraTime(species.firstSeen)}</p>
        )}
        {!once && (species.firstSeen !== null || species.lastSeen !== null) && (
          <p class="facts">
            {species.firstSeen !== null && (
              <span>First seen {formatCameraTime(species.firstSeen)}</span>
            )}
            {species.firstSeen !== null && species.lastSeen !== null && ' · '}
            {species.lastSeen !== null && (
              <span>last seen {formatCameraTime(species.lastSeen)}</span>
            )}
          </p>
        )}
        {activity && <p class="facts">{activity}</p>}
      </header>
      <div class="species-side">
        {!once && species.hours.some((value) => value > 0) && <HourBars hours={species.hours} />}
        <EventGrid
          events={species.events}
          labels={species.labels}
          name={species.name}
          thumbnailURL={thumbnailURL}
          photoURL={photoURL}
        />
      </div>
    </article>
  );
}
