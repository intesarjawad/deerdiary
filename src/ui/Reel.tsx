import { useEffect, useMemo, useState } from 'preact/hooks';
import packageJson from '../../package.json' with { type: 'json' };
import {
  REEL_UNSUPPORTED_MESSAGE,
  type ReelExporter,
  type ReelExportRequest,
} from '../app/reelExport';
import {
  commonName,
  REEL_CROSSFADE_MS,
  REEL_END_CARD_MS,
  REEL_SCALE_DRIFT,
  REEL_SHOT_MS,
  type ReelEndCard,
  type ReelShot,
  rankForReel,
  reelDurationMs,
  reelEndCard,
} from '../core/reel';
import type { DeerdiaryEvent } from '../core/types';
import { formatCameraTime } from './EventGrid';
import { cssVars } from './Tally';
import { lift } from './WhyLabel';

export { REEL_CROSSFADE_MS, REEL_END_CARD_MS, REEL_SCALE_DRIFT, REEL_SHOT_MS, rankForReel };

export const REEL_PROJECT_NAME = 'Deerdiary';
export const REEL_END_CARD_STORAGE_KEY = 'deerdiary.reel.include-end-card';

type PackageMetadata = { name: string; homepage?: string };
const packageMetadata: PackageMetadata = packageJson;
export const REEL_PAGES_URL: string | undefined = packageMetadata.homepage;

export type ReelStorage = Pick<Storage, 'getItem' | 'setItem'>;

const reelDate = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' });

function endCardLines(card: ReelEndCard): string[] {
  const species = card.species.map(
    (entry) =>
      `${entry.name}: ${entry.detections} ${entry.detections === 1 ? 'independent detection' : 'independent detections'}`,
  );
  const dates = formatReelDateRange(card.dateRange);
  return [...species, ...(dates ? [dates] : []), ...(card.pagesUrl ? [card.pagesUrl] : [])];
}

function endCardReadout(card: ReelEndCard): string {
  return ['End card', card.projectName, ...endCardLines(card)].join('. ');
}

/** What the exporter needs: the chosen shots' photos and, when it is on, the card's text. */
export function reelExportRequest(
  shots: readonly ReelShot[],
  card: ReelEndCard,
  includeEndCard: boolean,
): ReelExportRequest {
  return {
    paths: shots.map((shot) => shot.photo.path),
    endCard: includeEndCard ? { title: card.projectName, lines: endCardLines(card) } : null,
  };
}

/** The exported card keeps the wall-clock dates, never the viewer's timezone. */
export function formatReelDateRange(range: { first: number; last: number } | null): string | null {
  if (!range) return null;
  const first = reelDate.format(range.first);
  const last = reelDate.format(range.last);
  return first === last ? first : `${first} to ${last}`;
}

/** The checkbox starts on and remembers a deliberate choice. */
export function readIncludeEndCard(storage: ReelStorage | undefined): boolean {
  return storage?.getItem(REEL_END_CARD_STORAGE_KEY) !== 'false';
}

export function storeIncludeEndCard(storage: ReelStorage | undefined, value: boolean): void {
  storage?.setItem(REEL_END_CARD_STORAGE_KEY, value ? 'true' : 'false');
}

function browserStorage(): ReelStorage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** Arrow keys and Home/End move through the slides without waiting for the timer. */
export function nextReelSlide(index: number, count: number, key: string): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (index + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (index + count - 1) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

export type ReelProps = {
  events: readonly DeerdiaryEvent[];
  photoURL?: ((path: string) => string | undefined) | undefined;
  photoAvailable?: ((path: string) => boolean) | undefined;
  onAttachOriginals?: (() => void) | undefined;
  projectName?: string | undefined;
  pagesUrl?: string | undefined;
  /** Defaults to localStorage; a caller can pass a test double or a session store. */
  storage?: ReelStorage | undefined;
  onIncludeEndCardChange?: ((value: boolean) => void) | undefined;
  /** Without one the reel is a preview only. */
  exporter?: ReelExporter | undefined;
};

function ExportControls({
  exporter,
  request,
}: {
  exporter: ReelExporter;
  request: () => ReelExportRequest;
}) {
  const state = exporter.state.value;
  if (state.status === 'unsupported') return <p>{REEL_UNSUPPORTED_MESSAGE}</p>;
  return (
    <>
      <p>
        <button
          type="button"
          disabled={state.status === 'checking' || state.status === 'exporting'}
          onClick={() => void exporter.export(request())}
        >
          Export reel
        </button>
      </p>
      {state.status === 'exporting' && (
        <p role="status">
          <label>
            Exporting the reel: {state.percent}% <progress max={100} value={state.percent} />
          </label>
        </p>
      )}
      {state.status === 'failed' && <p role="alert">{state.message}</p>}
    </>
  );
}

/** A silent preview of the reel: one shot per chosen burst and the optional summary card. */
export function Reel({
  events,
  photoURL,
  projectName = REEL_PROJECT_NAME,
  pagesUrl = REEL_PAGES_URL,
  storage,
  onIncludeEndCardChange,
  exporter,
  photoAvailable,
  onAttachOriginals,
}: ReelProps) {
  const shots = useMemo(() => rankForReel(events), [events]);
  const endCard = useMemo(
    () => reelEndCard(events, { name: projectName, pagesUrl }),
    [events, projectName, pagesUrl],
  );
  const [includeEndCard, setIncludeEndCard] = useState(() =>
    readIncludeEndCard(storage ?? browserStorage()),
  );
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  const originalsMissing = shots.some((shot) => photoAvailable?.(shot.photo.path) === false);

  const slideCount = shots.length + (includeEndCard && shots.length > 0 ? 1 : 0);
  const current = slideCount === 0 ? 0 : index % slideCount;
  const endCardIndex = shots.length;
  const showingEndCard = includeEndCard && shots.length > 0 && current === endCardIndex;
  const duration = showingEndCard ? REEL_END_CARD_MS : REEL_SHOT_MS;

  useEffect(() => {
    if (paused || slideCount <= 1) return;
    const timer = setTimeout(() => setIndex((value) => (value + 1) % slideCount), duration);
    return () => clearTimeout(timer);
  }, [paused, slideCount, duration, current]);

  function move(step: number) {
    if (slideCount === 0) return;
    setIndex((value) => (value + step + slideCount) % slideCount);
  }

  function toggleEndCard(value: boolean) {
    setIncludeEndCard(value);
    storeIncludeEndCard(storage ?? browserStorage(), value);
    onIncludeEndCardChange?.(value);
    setIndex(0);
  }

  const currentShot: ReelShot | undefined = current < shots.length ? shots[current] : undefined;

  if (shots.length === 0) {
    return (
      <section aria-label="Species reel">
        <p>No species shots to show in a reel.</p>
      </section>
    );
  }

  return (
    <section class="reel-section">
      <h2>Reel</h2>
      <div
        class="reel"
        style={cssVars({
          '--reel-fade': `${REEL_CROSSFADE_MS}ms`,
          '--reel-shot': `${REEL_SHOT_MS}ms`,
          '--reel-scale': 1 + REEL_SCALE_DRIFT,
        })}
      >
        <div
          class="reel-stage"
          aria-label="Species reel"
          role="slider"
          aria-valuemin={1}
          aria-valuemax={slideCount}
          aria-valuenow={current + 1}
          aria-valuetext={
            showingEndCard
              ? endCardReadout(endCard)
              : currentShot
                ? `${commonName(currentShot.label)} at ${formatCameraTime(currentShot.photo.time.wallClockMs)}`
                : 'Reel'
          }
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === ' ') {
              event.preventDefault();
              setPaused((value) => !value);
              return;
            }
            const next = nextReelSlide(current, slideCount, event.key);
            if (next === null) return;
            event.preventDefault();
            setIndex(next);
          }}
        >
          {shots.map((shot, shotIndex) => {
            const source = photoURL?.(shot.photo.path);
            return (
              <div
                key={`${shot.event.cameraKey}-${shot.photo.path}`}
                class={`reel-slide reel-shot${shotIndex === current ? ' is-active' : ''}`}
                aria-hidden={shotIndex !== current}
              >
                {source ? (
                  <img
                    src={source}
                    alt={`${commonName(shot.label)} at ${formatCameraTime(shot.photo.time.wallClockMs)}`}
                    onLoad={lift}
                  />
                ) : (
                  <p class="reel-missing">{commonName(shot.label)}</p>
                )}
              </div>
            );
          })}
          {includeEndCard && (
            <div
              class={`reel-slide reel-end${showingEndCard ? ' is-active' : ''}`}
              aria-hidden={!showingEndCard}
            >
              <h3>{endCard.projectName}</h3>
              {endCard.species.length > 0 && (
                <ol>
                  {endCard.species.map((species) => (
                    <li key={species.label}>
                      {species.name}: {species.detections}{' '}
                      {species.detections === 1
                        ? 'independent detection'
                        : 'independent detections'}
                    </li>
                  ))}
                </ol>
              )}
              {formatReelDateRange(endCard.dateRange) && (
                <p>{formatReelDateRange(endCard.dateRange)}</p>
              )}
              {endCard.pagesUrl && <p>{endCard.pagesUrl}</p>}
            </div>
          )}
        </div>
        <p class="reel-live" aria-live="polite">
          {showingEndCard
            ? 'End card'
            : currentShot
              ? `${commonName(currentShot.label)} at ${formatCameraTime(currentShot.photo.time.wallClockMs)}`
              : ''}
        </p>
        <p class="actions">
          <button type="button" onClick={() => setPaused((value) => !value)}>
            {paused ? 'Play' : 'Pause'}
          </button>{' '}
          <button type="button" onClick={() => move(-1)}>
            Previous shot
          </button>{' '}
          <button type="button" onClick={() => move(1)}>
            Next shot
          </button>
        </p>
        <p>
          <label>
            <input
              type="checkbox"
              checked={includeEndCard}
              onChange={(event) => toggleEndCard(event.currentTarget.checked)}
            />{' '}
            Include end card
          </label>
        </p>
        <p>
          {shots.length} {shots.length === 1 ? 'shot' : 'shots'} ·{' '}
          {(reelDurationMs(shots.length, includeEndCard) / 1000).toFixed(1)} seconds
        </p>
        {originalsMissing && (
          <p role="status">
            Reel export needs the original photos. Attach the folder this diary came from.{' '}
            <button type="button" onClick={onAttachOriginals}>
              Attach originals
            </button>
          </p>
        )}
        {exporter && !originalsMissing && (
          <ExportControls
            exporter={exporter}
            request={() => reelExportRequest(shots, endCard, includeEndCard)}
          />
        )}
      </div>
    </section>
  );
}
