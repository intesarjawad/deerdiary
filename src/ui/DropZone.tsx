import type { ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { type ScannedFile, scanDrop, scanFiles, scanHandle, summarizeFiles } from '../files/scan';

const FORMATS = '.jpg and .jpeg photos and .mp4, .mov, .m4v and .avi clips';

/** What the folder held instead, named so the next try picks a different one. */
export function emptyFolderMessage(files: readonly ScannedFile[]): { title: string; body: string } {
  if (files.length === 0) {
    return {
      title: 'That folder is empty.',
      body: 'Open the card and choose the folder that holds the photos. On most cameras that is DCIM, or the numbered folder inside it, such as 100MEDIA.',
    };
  }
  const others = [
    ...new Set(files.map((file) => (file.ext ? `.${file.ext}` : 'no extension'))),
  ].sort();
  const count = files.length === 1 ? '1 file' : `${files.length} files`;
  return {
    title: 'No photos in that folder.',
    body: `Deerdiary reads ${FORMATS}. This folder holds ${count} of another kind (${others.join(', ')}). Choose the card's DCIM folder, or the numbered folder inside it, such as 100MEDIA.`,
  };
}

function EmptyFilm() {
  return (
    <svg class="empty-film" viewBox="0 0 220 64" aria-hidden="true">
      <rect x="1" y="1" width="218" height="62" rx="2" />
      {[0, 1, 2].map((frame) => (
        <rect key={frame} class="gap" x={14 + frame * 68} y="12" width="56" height="40" rx="1" />
      ))}
      <path d="M96 20l32 24M128 20L96 44" />
    </svg>
  );
}

export type DropZoneProps = {
  disabled?: boolean;
  onScan?: (files: ScannedFile[]) => void | Promise<void>;
  /** Extra actions that sit beside the folder button. */
  children?: ComponentChildren;
};

/** Folder intake and kind summary; processing is owned by the caller. */
export function DropZone({ onScan, children, disabled = false }: DropZoneProps) {
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState('Reads .jpg photos and .mp4, .mov, .m4v and .avi clips.');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [empty, setEmpty] = useState<ScannedFile[] | null>(null);

  async function scan(result: Promise<ScannedFile[]>) {
    if (disabled || busy) return;
    setBusy(true);
    setError('');
    setEmpty(null);
    setStatus('Scanning folder.');
    try {
      const files = await result;
      setStatus(summarizeFiles(files));
      setEmpty(files.some(({ kind }) => kind === 'photo' || kind === 'video') ? null : files);
      await onScan?.(files);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') {
        setStatus('No folder selected.');
      } else {
        setStatus('Folder scan failed.');
        setError(
          `Could not read the folder. Choose it again and allow access. ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    } finally {
      setBusy(false);
    }
  }

  function chooseFolder() {
    if (disabled || busy) return;
    if (typeof window.showDirectoryPicker === 'function') {
      void scan(window.showDirectoryPicker().then((handle) => scanHandle(handle)));
    } else {
      input.current?.click();
    }
  }

  return (
    <section
      class={dragging ? 'dropzone is-dragging' : 'dropzone'}
      aria-label="Folder intake"
      aria-busy={busy || disabled}
      onDragOver={(event) => event.preventDefault()}
      onDragEnter={() => {
        if (!disabled && !busy) setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (disabled || busy) return;
        setDragging(false);
        if (event.dataTransfer) void scan(scanDrop(event.dataTransfer.items));
      }}
    >
      <p class="drop-title">
        {dragging ? 'Let go to read the card.' : 'Drop the card folder here.'}
      </p>
      <div class="actions">
        <button type="button" class="primary" disabled={disabled || busy} onClick={chooseFolder}>
          Choose a folder
        </button>
        {children}
      </div>
      <input
        ref={(element) => {
          input.current = element;
          element?.setAttribute('webkitdirectory', '');
        }}
        aria-label="Folder files"
        type="file"
        multiple
        disabled={disabled || busy}
        hidden
        onChange={(event) => {
          void scan(Promise.resolve(scanFiles(event.currentTarget.files ?? [])));
          event.currentTarget.value = '';
        }}
      />
      <p class="hint" role="status">
        {status}
      </p>
      {error && <p role="alert">{error}</p>}
      {empty && (
        <div class="empty-folder">
          <EmptyFilm />
          <div>
            <p class="empty-title">{emptyFolderMessage(empty).title}</p>
            <p class="empty-body">{emptyFolderMessage(empty).body}</p>
          </div>
        </div>
      )}
    </section>
  );
}
