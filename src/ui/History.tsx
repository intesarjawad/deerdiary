import { useId } from 'preact/hooks';
import { type ExportFile, exportJson } from '../app/export';
import { parseImport } from '../app/import';
import { importedOutput } from '../app/importDiary';
import { type CamtrapDraft, isCamtrapDraft } from '../core/camtrapMetadata';
import { type SessionSummary, sessionCorrections, sessionEvents } from '../core/history';
import { type CameraTime, isCameraTime, isDateMs, wallClockDateRange } from '../core/time';
import type { Session, StoredResult } from '../storage/schema';

export const HISTORY_BACKUP_NOTE =
  "Clearing this site's data in the browser deletes your diaries; the export is the backup.";
export const DELETE_CONFIRMATION =
  'Delete this session and its photos, previews and corrections from this browser? This cannot be undone.';

const count = new Intl.NumberFormat('en-US');

/** Camera readings are wall-clock values stored as UTC, so the date is read back in UTC. */
function day(wallClockMs: number): string {
  return new Date(wallClockMs).toISOString().slice(0, 10);
}

export function dateRangeLabel(range: SessionSummary['dateRange']): string {
  if (range === null) return 'No dated photos';
  if (!isDateMs(range.first) || !isDateMs(range.last)) return 'Invalid saved date';
  const first = day(range.first);
  const last = day(range.last);
  return first === last ? first : `${first} to ${last}`;
}

/**
 * The diary as the SpeciesNet JSON export, plus the session's id and each photo's key and camera
 * time. Those extras are what let an import put the same row back; other readers ignore them.
 */
export function exportSession(
  session: Session,
  results: readonly StoredResult[],
  corrections: Readonly<Record<string, string>>,
): ExportFile {
  const own = results.filter(({ key }) => session.fileKeys.includes(key));
  const written = JSON.parse(
    exportJson({
      results: own,
      events: sessionEvents(session, own),
      corrections: sessionCorrections(session, own, corrections),
    }),
  );
  written.deerdiary.session = {
    id: session.id,
    ...(session.camtrap === undefined ? {} : { camtrap: session.camtrap }),
    created_at_ms: session.createdAtMs,
    photos: own.map(({ key, time, output }) => ({ key, path: output.path, time })),
  };
  return {
    name: `deerdiary-session-${session.id}.json`,
    type: 'application/json;charset=utf-8',
    text: JSON.stringify(written, null, 2),
  };
}

export type RestoredSession = {
  session: Session;
  results: StoredResult[];
  corrections: Readonly<Record<string, string>>;
};

export type RestoreResult = { ok: true; value: RestoredSession } | { ok: false; field: string };

type PhotoMeta = { key: string; time: CameraTime };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sessionBlock(
  text: string,
):
  | { id: string; createdAtMs: number; photos: Map<string, PhotoMeta>; camtrap?: CamtrapDraft }
  | undefined {
  const root: unknown = JSON.parse(text);
  const block = isRecord(root) ? (root.deerdiary ?? root.wild) : undefined;
  const raw = isRecord(block) ? block.session : undefined;
  if (!isRecord(raw) || typeof raw.id !== 'string') return undefined;
  if (!isDateMs(raw.created_at_ms) || !Array.isArray(raw.photos)) return undefined;
  if (raw.camtrap !== undefined && !isCamtrapDraft(raw.camtrap)) return undefined;
  const photos = new Map<string, PhotoMeta>();
  for (const photo of raw.photos) {
    if (!isRecord(photo) || typeof photo.path !== 'string' || typeof photo.key !== 'string') {
      return undefined;
    }
    if (!isCameraTime(photo.time)) return undefined;
    photos.set(photo.path, { key: photo.key, time: photo.time });
  }
  return {
    id: raw.id,
    createdAtMs: raw.created_at_ms,
    photos,
    ...(raw.camtrap === undefined ? {} : { camtrap: raw.camtrap }),
  };
}

/**
 * Rebuilds a diary from a backup. Previews are not in the backup, so reopened photos need
 * their original folder reattached.
 */
export function restoreSession(text: string): RestoreResult {
  const imported = parseImport(text);
  if (!imported.ok) return imported;
  const block = sessionBlock(text);
  if (block === undefined) return { ok: false, field: 'deerdiary.session' };

  const results: StoredResult[] = [];
  for (const [index, photo] of imported.value.photos.entries()) {
    const meta = block.photos.get(photo.path);
    if (meta === undefined) return { ok: false, field: 'deerdiary.session.photos' };
    const output = importedOutput(photo, {
      path: photo.path,
      thumbnail: new Blob([]),
      field: `predictions[${index}]`,
    });
    if (!output.ok) return output;
    results.push({ key: meta.key, time: meta.time, output: output.value });
  }
  return {
    ok: true,
    value: {
      session: {
        id: block.id,
        ...(block.camtrap === undefined ? {} : { camtrap: block.camtrap }),
        createdAtMs: block.createdAtMs,
        fileKeys: results.map(({ key }) => key),
        dateRange: wallClockDateRange(results.map(({ time }) => time)),
      },
      results,
      corrections: imported.value.corrections,
    },
  };
}

export type HistoryProps = {
  /** Newest first, as the summaries are listed. */
  summaries: readonly SessionSummary[];
  onOpen: (id: string) => void;
  onExport: (id: string) => void;
  onDelete: (id: string) => void;
  onImport: (file: File) => void;
  /** The outcome of the last import, export or delete when it needs saying. */
  message?: string | null | undefined;
};

function photosLabel(value: number): string {
  return `${count.format(value)} ${value === 1 ? 'photo' : 'photos'}`;
}

function detectionsLabel(value: number): string {
  return `${count.format(value)} independent ${value === 1 ? 'detection' : 'detections'}`;
}

function SessionRow({
  summary,
  onOpen,
  onExport,
  onDelete,
}: {
  summary: SessionSummary;
  onOpen: HistoryProps['onOpen'];
  onExport: HistoryProps['onExport'];
  onDelete: HistoryProps['onDelete'];
}) {
  const heading = useId();
  return (
    <article aria-labelledby={heading}>
      <h3 id={heading}>{dateRangeLabel(summary.dateRange)}</h3>
      <p>{photosLabel(summary.photoCount)}</p>
      {summary.species.length === 0 ? (
        <p>No species found.</p>
      ) : (
        <ul>
          {summary.species.map((species) => (
            <li key={species.label}>
              {species.name}: {detectionsLabel(species.detections)}
            </li>
          ))}
        </ul>
      )}
      <p>
        <button type="button" aria-describedby={heading} onClick={() => onOpen(summary.id)}>
          Open this session
        </button>{' '}
        <button type="button" aria-describedby={heading} onClick={() => onExport(summary.id)}>
          Export this session
        </button>{' '}
        <button
          type="button"
          aria-describedby={heading}
          onClick={() => {
            if (confirm(DELETE_CONFIRMATION)) onDelete(summary.id);
          }}
        >
          Delete this session
        </button>
      </p>
    </article>
  );
}

/** Saved diaries, newest first, with open, export and delete controls. */
export function History({
  summaries,
  onOpen,
  onExport,
  onDelete,
  onImport,
  message,
}: HistoryProps) {
  return (
    <section aria-label="History">
      <h2>History</h2>
      <p>{HISTORY_BACKUP_NOTE}</p>
      <p>
        <label class="file-action">
          Import a session file
          <input
            class="vh"
            type="file"
            accept=".json,application/json"
            onChange={(event) => {
              const input = event.currentTarget;
              const file = input.files?.[0];
              input.value = '';
              if (file) onImport(file);
            }}
          />
        </label>
      </p>
      {message && <p role="status">{message}</p>}
      {summaries.length === 0 ? (
        <p>No saved sessions yet.</p>
      ) : (
        <ol class="sessions">
          {summaries.map((summary) => (
            <li key={summary.id}>
              <SessionRow
                summary={summary}
                onOpen={onOpen}
                onExport={onExport}
                onDelete={onDelete}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
