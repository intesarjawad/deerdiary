import { useEffect, useId, useMemo, useRef, useState } from 'preact/hooks';
import { correctionKey, eventId } from '../app/export';
import { burstCounter, sightingLabel } from '../core/events';
import { titleName } from '../core/explain';
import type { DeerdiaryEvent, Detection, PhotoResult } from '../core/types';
import { formatCameraTime } from './EventGrid';
import { aroundBox, lift, WhyLabel } from './WhyLabel';

export const CORRECTION_MATCH_LIMIT = 50;
const NOT_CORRECTABLE = new Set(['blank', 'human', 'vehicle']);
const UNIDENTIFIED = new Set(['animal', 'no cv result', 'unknown']);

export type CorrectionEntry = {
  /** The same key the CSV export reads, so a correction applies to exactly this event and label. */
  key: string;
  eventId: string;
  label: string;
  commonName: string;
  scientificName: string | null;
};

export type LabelNames = { commonName: string; scientificName: string | null };

/** Labels are semicolon fields; the last one is the common name and 4 and 5 are genus and species. */
export function labelNames(label: string): LabelNames {
  const parts = label.split(';');
  const common = parts.at(-1) || label;
  return {
    commonName: titleName(label),
    scientificName: UNIDENTIFIED.has(common)
      ? null
      : // A binomial is written with its genus capitalised: Felis catus.
        [parts[4], parts[5]]
          .filter(Boolean)
          .join(' ')
          .replace(/^./, (first) => first.toUpperCase()) || null,
  };
}

function matches(label: string, query: string): boolean {
  const names = labelNames(label);
  return (
    names.commonName.toLowerCase().includes(query) ||
    (names.scientificName?.toLowerCase().includes(query) ?? false)
  );
}

/** Filters the classifier vocabulary by either name without changing its published order. */
export function filterLabels(
  labels: readonly string[],
  query: string,
  limit = CORRECTION_MATCH_LIMIT,
): string[] {
  const maximum = Math.max(0, limit);
  const needle = query.trim().toLowerCase();
  if (needle === '') return labels.slice(0, maximum);
  if (maximum === 0) return [];
  const found: string[] = [];
  for (const label of labels) {
    if (matches(label, needle)) found.push(label);
    if (found.length === maximum) break;
  }
  return found;
}

/** One row per event and species; a mixed-species burst gets one row for each species. */
export function correctionEntries(events: readonly DeerdiaryEvent[]): CorrectionEntry[] {
  const entries: CorrectionEntry[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const id = eventId(event);
    for (const { label } of event.species) {
      const names = labelNames(label);
      if (NOT_CORRECTABLE.has(names.commonName)) continue;
      const key = correctionKey(id, label);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        key,
        eventId: id,
        label,
        commonName: names.commonName,
        scientificName: names.scientificName,
      });
    }
  }
  return entries;
}

export type CorrectionEvidence = { photo: PhotoResult; detection: Detection };

/** The first detection the diary counted as a species in an event; the row explains that box. */
export function correctionEvidence(
  event: DeerdiaryEvent | undefined,
  label: string,
): CorrectionEvidence | undefined {
  if (event === undefined) return undefined;
  const counted = burstCounter(event.photos);
  for (const photo of event.photos) {
    for (const detection of photo.detections) {
      if (counted(detection) === label) return { photo, detection };
    }
  }
  return undefined;
}

type CorrectionRowProps = {
  entry: CorrectionEntry;
  labels: readonly string[];
  corrected: string | undefined;
  onChange: (key: string, value: string | null) => void;
  editing: boolean;
  onEdit: (key: string | null) => void;
  explaining: boolean;
  onExplain: (key: string | null) => void;
  whyId: string;
};

/** One species in a burst: its name, and the species field only while it is being corrected. */
function CorrectionRow({
  entry,
  labels,
  corrected,
  onChange,
  editing,
  onEdit,
  explaining,
  onExplain,
  whyId,
}: CorrectionRowProps) {
  const inputId = useId();
  const listId = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const matches = useMemo(() => (open ? filterLabels(labels, query) : []), [labels, query, open]);
  const activeLabel = matches[active];
  const field = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  // The field appears because the reader asked to correct this species, so it takes focus.
  useEffect(() => {
    if (editing) field.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, activeLabel, listId]);

  function close() {
    setQuery('');
    setOpen(false);
    setActive(0);
    onEdit(null);
    requestAnimationFrame(() => trigger.current?.focus());
  }

  function choose(label: string) {
    onChange(entry.key, label);
    close();
  }

  return (
    <li>
      {corrected && (
        <p class="taxon">
          Now <strong>{labelNames(corrected).commonName}</strong>
        </p>
      )}
      <p class="row-actions">
        <button
          type="button"
          ref={trigger}
          aria-expanded={editing}
          aria-controls={editing ? inputId : undefined}
          onClick={() => (editing ? close() : onEdit(entry.key))}
        >
          {editing ? 'Cancel' : 'Correct'}
          <span class="visually-hidden"> {entry.commonName}</span>
        </button>
        {corrected && (
          <button type="button" onClick={() => onChange(entry.key, null)}>
            Reset<span class="visually-hidden"> {entry.commonName}</span>
          </button>
        )}
        <button
          type="button"
          aria-expanded={explaining}
          aria-controls={explaining ? whyId : undefined}
          onClick={() => onExplain(explaining ? null : entry.key)}
        >
          Why this label<span class="visually-hidden"> for {entry.commonName}</span>
        </button>
      </p>
      {editing && (
        <div class="edit">
          <label for={inputId}>Correct species</label>
          <input
            id={inputId}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listId}
            aria-activedescendant={open && activeLabel ? `${listId}-${active}` : undefined}
            ref={field}
            value={query}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onInput={(event) => {
              setQuery(event.currentTarget.value);
              setActive(0);
              setOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setOpen(true);
                setActive((value) => (value + 1) % Math.max(1, matches.length));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setOpen(true);
                setActive((value) => (value + matches.length - 1) % Math.max(1, matches.length));
              } else if (event.key === 'Enter' && open && activeLabel) {
                event.preventDefault();
                choose(activeLabel);
              } else if (event.key === 'Escape') {
                if (open) setOpen(false);
                else close();
              }
            }}
          />
          {open && (
            <div
              id={listId}
              role="listbox"
              aria-label={`Species matching ${query || 'the start of the list'}`}
              class="options"
            >
              {matches.map((label, index) => {
                const names = labelNames(label);
                return (
                  <div
                    key={label}
                    id={`${listId}-${index}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={index === active}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(label)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      choose(label);
                    }}
                    class="option"
                  >
                    {names.commonName}
                    {names.scientificName && <span> ({names.scientificName})</span>}
                  </div>
                );
              })}
            </div>
          )}
          {open && matches.length === 0 && <p>No matching species.</p>}
        </div>
      )}
    </li>
  );
}

export type CorrectionStorage = {
  saveCorrection(key: string, value: string): Promise<void>;
  deleteCorrection(key: string): Promise<void>;
};

export type CorrectionsProps = {
  events: readonly DeerdiaryEvent[];
  labels: readonly string[];
  corrections: Readonly<Record<string, string>>;
  onChange: (key: string, value: string | null) => void;
  /** Optional persistence adapter; the caller keeps the corrections record in its own state. */
  storage?: CorrectionStorage | undefined;
  /** The country used when the card was processed, shown by "Why this label". */
  country?: string | undefined;
  /** Resolves a full frame, or a thumbnail when that is all the caller kept, for the crop. */
  imageURL?: ((path: string) => string | undefined) | undefined;
};

/**
 * The card's species, each with one row per burst: its date and the photo it was counted from. A
 * row takes the species field only when the reader chooses to correct it, and one explanation opens
 * under the burst it belongs to.
 */
export function Corrections({
  events,
  labels,
  corrections,
  onChange,
  storage,
  country,
  imageURL,
}: CorrectionsProps) {
  const entries = useMemo(() => correctionEntries(events), [events]);
  // Grouped by species, in the order each first appears on the card, one row per burst.
  const kinds = useMemo(() => {
    const byId = new Map<string, DeerdiaryEvent>(events.map((event) => [eventId(event), event]));
    const groups = new Map<
      string,
      {
        key: string;
        commonName: string;
        scientificName: string | null;
        rows: { event: DeerdiaryEvent; entry: CorrectionEntry }[];
      }
    >();
    for (const entry of entries) {
      const event = byId.get(entry.eventId);
      if (!event) continue;
      const group = groups.get(entry.label) ?? {
        key: entry.label,
        commonName: entry.commonName,
        scientificName: entry.scientificName,
        rows: [],
      };
      group.rows.push({ event, entry });
      groups.set(entry.label, group);
    }
    return [...groups.values()];
  }, [events, entries]);
  const [editing, setEditing] = useState<string | null>(null);
  const [explaining, setExplaining] = useState<string | null>(null);
  const whyId = useId();

  function apply(key: string, value: string | null) {
    onChange(key, value);
    if (!storage) return;
    const saved =
      value === null ? storage.deleteCorrection(key) : storage.saveCorrection(key, value);
    void saved.catch((error: unknown) => {
      console.error('Could not save the correction.', error);
    });
  }

  if (entries.length === 0) {
    return (
      <section aria-label="Species corrections">
        <p>No species to correct in these photos.</p>
      </section>
    );
  }
  return (
    <section class="corrections-section" aria-label="Species corrections">
      <h2>Correct species</h2>
      <p>A correction replaces one species in one burst and leaves the other species untouched.</p>
      <ol class="corrections">
        {kinds.map(({ key, commonName, scientificName, rows }) => (
          <li key={key} class="kind">
            <h3 class="kind-name">
              {commonName}
              {scientificName && <i> {scientificName}</i>}
              <span class="kind-count">
                {rows.length} {rows.length === 1 ? 'burst' : 'bursts'}
              </span>
            </h3>
            <ol class="kind-bursts">
              {rows.map(({ event, entry }) => {
                const thumb = correctionEvidence(event, entry.label);
                const src = thumb && imageURL?.(thumb.photo.path);
                const evidence = explaining === entry.key ? thumb : undefined;
                const [left, top, size] = aroundBox(thumb?.detection.bbox ?? [0.4, 0.4, 0.2, 0.2]);
                return (
                  <li
                    key={entry.key}
                    class={evidence || editing === entry.key ? 'burst is-open' : 'burst'}
                  >
                    <span class="thumb">
                      {src && (
                        <img
                          src={src}
                          alt=""
                          onLoad={lift}
                          style={{
                            left: `${(-left / size) * 100}%`,
                            top: `${(-top / size) * 100}%`,
                            width: `${100 / size}%`,
                            height: `${100 / size}%`,
                          }}
                        />
                      )}
                    </span>
                    <p class="when">
                      {formatCameraTime((event.photos[0] as PhotoResult).time.wallClockMs)}
                    </p>
                    <ul class="burst-species">
                      <CorrectionRow
                        entry={entry}
                        labels={labels}
                        corrected={corrections[entry.key]}
                        onChange={apply}
                        editing={editing === entry.key}
                        onEdit={setEditing}
                        explaining={explaining === entry.key}
                        onExplain={setExplaining}
                        whyId={whyId}
                      />
                    </ul>
                    {evidence && (
                      <div id={whyId} class="why">
                        <WhyLabel
                          detection={evidence.detection}
                          country={country}
                          countedAs={
                            sightingLabel(evidence.detection) !== entry.label
                              ? entry.label
                              : undefined
                          }
                          imageURL={imageURL?.(evidence.photo.path)}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          </li>
        ))}
      </ol>
    </section>
  );
}
