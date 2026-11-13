export type FileKind = 'photo' | 'video' | 'audio' | 'unsupported';

export type ScannedFile = {
  path: string;
  name: string;
  kind: FileKind;
  ext: string;
  sizeBytes: number;
  mtimeMs: number;
  source: FileSystemFileHandle | File;
};

const extensions = new Map<string, FileKind>([
  ['jpg', 'photo'],
  ['jpeg', 'photo'],
  ['mp4', 'video'],
  ['mov', 'video'],
  ['m4v', 'video'],
  ['avi', 'video'],
  ['wav', 'audio'],
  ['flac', 'audio'],
  ['mp3', 'audio'],
  ['ogg', 'audio'],
]);

function skip(name: string): boolean {
  return name.startsWith('.') || /^THUMB/i.test(name) || name === 'System Volume Information';
}

export function scannedFile(file: File, path: string, source: ScannedFile['source']): ScannedFile {
  const dot = file.name.lastIndexOf('.');
  const ext = dot < 0 ? '' : file.name.slice(dot + 1).toLowerCase();
  return {
    path,
    name: file.name,
    kind: extensions.get(ext) ?? 'unsupported',
    ext,
    sizeBytes: file.size,
    mtimeMs: file.lastModified,
    source,
  };
}

/** Scans a directory input, preserving paths relative to the selected folder's parent. */
export function scanFiles(files: Iterable<File>): ScannedFile[] {
  return Array.from(files).flatMap((file) => {
    const path = file.webkitRelativePath || file.name;
    return path.split('/').some(skip) ? [] : [scannedFile(file, path, file)];
  });
}

function isDirectoryHandle(handle: FileSystemHandle): handle is FileSystemDirectoryHandle {
  return handle.kind === 'directory';
}

function isFileHandle(handle: FileSystemHandle): handle is FileSystemFileHandle {
  return handle.kind === 'file';
}

/** Walks a modern handle tree without retaining file contents in the result. */
export async function scanHandle(handle: FileSystemHandle, parent = ''): Promise<ScannedFile[]> {
  if (skip(handle.name)) return [];
  const path = parent ? `${parent}/${handle.name}` : handle.name;
  if (isFileHandle(handle)) return [scannedFile(await handle.getFile(), path, handle)];
  const files: ScannedFile[] = [];
  if (isDirectoryHandle(handle)) {
    for await (const child of handle.values()) files.push(...(await scanHandle(child, path)));
  }
  return files;
}

function isDirectoryEntry(entry: FileSystemEntry): entry is FileSystemDirectoryEntry {
  return entry.isDirectory;
}

function isFileEntry(entry: FileSystemEntry): entry is FileSystemFileEntry {
  return entry.isFile;
}

/** Drains every readEntries batch, including nested directories, until the empty sentinel. */
export async function scanEntry(entry: FileSystemEntry, parent = ''): Promise<ScannedFile[]> {
  if (skip(entry.name)) return [];
  const path = parent ? `${parent}/${entry.name}` : entry.name;
  if (isFileEntry(entry)) {
    const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));
    return [scannedFile(file, path, file)];
  }
  const files: ScannedFile[] = [];
  if (isDirectoryEntry(entry)) {
    const reader = entry.createReader();
    while (true) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (batch.length === 0) break;
      for (const child of batch) files.push(...(await scanEntry(child, path)));
    }
  }
  return files;
}

/** Captures drop access synchronously, before the event's data store becomes protected. */
export function scanDrop(items: Iterable<DataTransferItem>): Promise<ScannedFile[]> {
  const captured = Array.from(items)
    .filter((item) => item.kind === 'file')
    .map((item) => ({
      handle:
        typeof item.getAsFileSystemHandle === 'function' ? item.getAsFileSystemHandle() : null,
      entry: typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null,
      file: item.getAsFile(),
    }));
  return Promise.all(
    captured.map(async ({ handle, entry, file }) => {
      const resolved = await handle;
      if (resolved) return scanHandle(resolved);
      // WebKit entries for in-memory files have no backing filesystem path.
      if (file && entry?.isFile) return scanFiles([file]);
      if (entry) return scanEntry(entry);
      return file ? scanFiles([file]) : [];
    }),
  ).then((groups) => groups.flat());
}

/** Formats the intake counts, including every unsupported extension. */
export function summarizeFiles(files: readonly ScannedFile[]): string {
  const counts = { photo: 0, video: 0, audio: 0, unsupported: 0 };
  const unsupported = new Set<string>();
  for (const file of files) {
    counts[file.kind]++;
    if (file.kind === 'unsupported') unsupported.add(file.ext ? `.${file.ext}` : 'no extension');
  }
  return `${counts.photo} photo${counts.photo === 1 ? '' : 's'}, ${counts.video} video${counts.video === 1 ? '' : 's'}, ${counts.audio} audio file${counts.audio === 1 ? '' : 's'}, ${counts.unsupported} unsupported${unsupported.size ? ` (${Array.from(unsupported).sort().join(', ')})` : ''}`;
}
