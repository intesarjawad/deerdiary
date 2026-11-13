import { expect, test, vi } from 'vitest';
import { scanDrop, scanEntry, scanFiles, scanHandle, summarizeFiles } from '../../src/files/scan';

function file(name: string, path = name): File {
  const result = new File(['jpeg'], name, { lastModified: 1234 });
  Object.defineProperty(result, 'webkitRelativePath', { value: path });
  return result;
}

function fileHandle(name: string): FileSystemFileHandle {
  return {
    name,
    kind: 'file',
    isFile: true,
    isDirectory: false,
    getFile: vi.fn(async () => file(name)),
    createWritable: vi.fn(),
    createSyncAccessHandle: vi.fn(),
    isSameEntry: vi.fn(),
    queryPermission: vi.fn(),
    requestPermission: vi.fn(),
  };
}

function directoryHandle(
  name: string,
  children: FileSystemHandleUnion[],
): FileSystemDirectoryHandle {
  return {
    name,
    kind: 'directory',
    isFile: false,
    isDirectory: true,
    async *values() {
      yield* children;
      return undefined;
    },
    entries: vi.fn(),
    keys: vi.fn(),
    [Symbol.asyncIterator]: vi.fn(),
    getDirectoryHandle: vi.fn(),
    getFileHandle: vi.fn(),
    removeEntry: vi.fn(),
    resolve: vi.fn(),
    isSameEntry: vi.fn(),
    queryPermission: vi.fn(),
    requestPermission: vi.fn(),
    getEntries: vi.fn(),
    getFile: vi.fn(),
    getDirectory: vi.fn(),
  };
}

function entryBase(name: string) {
  return {
    name,
    fullPath: `/${name}`,
    getParent: vi.fn(),
    filesystem: {
      name: 'test',
      get root(): FileSystemDirectoryEntry {
        throw new Error('Filesystem root is not used in scans.');
      },
    },
  };
}

function fileEntry(name: string): FileSystemFileEntry {
  return {
    ...entryBase(name),
    isFile: true,
    isDirectory: false,
    file: vi.fn((success) => success(file(name))),
  };
}

function directoryEntry(name: string, children: FileSystemEntry[]) {
  let offset = 0;
  const reader = {
    readEntries: vi.fn<FileSystemDirectoryReader['readEntries']>((success) => {
      success(children.slice(offset, offset + 100));
      offset += 100;
    }),
  };
  const entry = {
    ...entryBase(name),
    isFile: false,
    isDirectory: true,
    createReader: vi.fn(() => reader),
    getFile: vi.fn(),
    getDirectory: vi.fn(),
  } satisfies FileSystemDirectoryEntry;
  return { entry, reader };
}

test('drains 250 legacy entries through 100, 100, 50 and empty batches', async () => {
  const { entry, reader } = directoryEntry(
    'card',
    Array.from({ length: 250 }, (_, index) => fileEntry(`${index}.jpg`)),
  );
  const files = await scanEntry(entry);
  expect(files).toHaveLength(250);
  expect(new Set(files.map((item) => item.path)).size).toBe(250);
  expect(files.at(-1)?.path).toBe('card/249.jpg');
  expect(entry.createReader).toHaveBeenCalledOnce();
  expect(reader.readEntries).toHaveBeenCalledTimes(4);
});

test('walks 250 modern handles and preserves the source handle and metadata', async () => {
  const handles = Array.from({ length: 250 }, (_, index) => fileHandle(`${index}.JPG`));
  const files = await scanHandle(directoryHandle('card', [directoryHandle('DCIM', handles)]));
  expect(files).toHaveLength(250);
  expect(files[0]).toEqual({
    path: 'card/DCIM/0.JPG',
    name: '0.JPG',
    ext: 'jpg',
    kind: 'photo',
    sizeBytes: 4,
    mtimeMs: 1234,
    source: handles[0],
  });
});

test('all intake paths skip hidden and system trees before reading their contents', async () => {
  const names = [
    '.hidden.jpg',
    'THUMB001.JPG',
    'thumbs.db',
    '.thumbnails',
    'System Volume Information',
  ];
  const hiddenHandles = names.map((name) => directoryHandle(name, [fileHandle('hidden.jpg')]));
  const hiddenEntries = names.map((name) => directoryEntry(name, [fileEntry('hidden.jpg')]).entry);
  const nested = directoryEntry('DCIM', [fileEntry('visible.jpg'), ...hiddenEntries]);
  const legacy = await scanEntry(directoryEntry('card', [nested.entry]).entry);
  const modern = await scanHandle(
    directoryHandle('card', [
      directoryHandle('DCIM', [fileHandle('visible.jpg'), ...hiddenHandles]),
    ]),
  );
  const input = scanFiles([
    file('visible.jpg', 'card/DCIM/visible.jpg'),
    ...names.map((name) => file('hidden.jpg', `card/DCIM/${name}/hidden.jpg`)),
  ]);
  for (const result of [legacy, modern, input]) {
    expect(result.map((item) => item.path)).toEqual(['card/DCIM/visible.jpg']);
  }
  for (const entry of hiddenEntries) expect(entry.createReader).not.toHaveBeenCalled();
});

test('classifies every supported extension case-insensitively and ignores MIME guesses', () => {
  const extensions = [
    'JPG',
    'jpeg',
    'mp4',
    'MOV',
    'm4v',
    'avi',
    'wav',
    'FLAC',
    'mp3',
    'ogg',
    'heic',
    'png',
    '',
  ];
  const files = scanFiles(extensions.map((ext) => file(ext ? `test.${ext}` : 'README')));
  expect(files.map((item) => item.kind)).toEqual([
    'photo',
    'photo',
    'video',
    'video',
    'video',
    'video',
    'audio',
    'audio',
    'audio',
    'audio',
    'unsupported',
    'unsupported',
    'unsupported',
  ]);
  expect(summarizeFiles(files)).toBe(
    '2 photos, 4 videos, 4 audio files, 3 unsupported (.heic, .png, no extension)',
  );
});

test('formats the F1 summary and deduplicates unsupported extensions', () => {
  const photos = Array.from({ length: 12 }, (_, index) => file(`${index}.jpg`));
  const files = scanFiles([
    ...photos,
    file('one.mp4'),
    file('two.avi'),
    file('one.wav'),
    file('one.heic'),
  ]);
  expect(summarizeFiles(files)).toBe('12 photos, 2 videos, 1 audio file, 1 unsupported (.heic)');
  expect(summarizeFiles(scanFiles([file('one.HEIC'), file('two.heic')]))).toBe(
    '0 photos, 0 videos, 0 audio files, 2 unsupported (.heic)',
  );
  expect(summarizeFiles([])).toBe('0 photos, 0 videos, 0 audio files, 0 unsupported');
  expect(summarizeFiles(scanFiles([file('one.jpg'), file('two.mov')]))).toBe(
    '1 photo, 1 video, 0 audio files, 0 unsupported',
  );
});

test('keeps unknown extensions unsupported even when they name object properties', () => {
  const files = scanFiles([
    file('image.constructor'),
    file('image.toString'),
    file('image.__proto__'),
  ]);
  expect(files.map((item) => item.kind)).toEqual(['unsupported', 'unsupported', 'unsupported']);
});

test('empty directories produce no files on either tree API', async () => {
  expect(await scanHandle(directoryHandle('empty', []))).toEqual([]);
  const { entry, reader } = directoryEntry('empty', []);
  expect(await scanEntry(entry)).toEqual([]);
  expect(reader.readEntries).toHaveBeenCalledOnce();
});

function dropItem(options: {
  handle?: Promise<FileSystemHandle | null>;
  entry?: FileSystemEntry | null;
  file?: File | null;
  kind?: string;
}): DataTransferItem {
  const item = {
    kind: options.kind ?? 'file',
    type: '',
    getAsFile: vi.fn(() => options.file ?? null),
    webkitGetAsEntry: vi.fn(() => options.entry ?? null),
    getAsString: vi.fn(),
    getAsFileSystemHandle: vi.fn(() => options.handle ?? Promise.resolve(null)),
  };
  if (!options.handle) Reflect.deleteProperty(item, 'getAsFileSystemHandle');
  return item;
}

test('captures every handle during the drop event and prefers it to legacy entries', async () => {
  const items = [
    dropItem({ handle: Promise.resolve(fileHandle('first.jpg')), entry: fileEntry('wrong.jpg') }),
    dropItem({ handle: Promise.resolve(fileHandle('second.jpg')) }),
  ];
  const scanning = scanDrop(items);
  for (const item of items) expect(item.getAsFileSystemHandle).toHaveBeenCalledOnce();
  expect((await scanning).map((item) => item.name)).toEqual(['first.jpg', 'second.jpg']);
});

test('falls back to entries, then loose files, and ignores text and null items', async () => {
  const { entry } = directoryEntry('card', [fileEntry('nested.wav')]);
  const looseFile = dropItem({ file: file('loose.jpeg') });
  Reflect.deleteProperty(looseFile, 'webkitGetAsEntry');
  const files = await scanDrop([
    dropItem({ entry }),
    looseFile,
    dropItem({ handle: Promise.resolve(null), entry: fileEntry('fallback.mp4') }),
    dropItem({ kind: 'string', file: file('ignore.jpg') }),
    dropItem({}),
  ]);
  expect(files.map((item) => item.path)).toEqual(['card/nested.wav', 'loose.jpeg', 'fallback.mp4']);
});

test('uses captured files when WebKit supplies entries without a filesystem path', async () => {
  const photo = file('photo.jpg');
  const entry = fileEntry(photo.name);
  entry.file = (_success, reject) =>
    reject?.(new DOMException('Path does not exist', 'NotFoundError'));

  const files = await scanDrop([dropItem({ entry, file: photo })]);
  expect(files).toEqual(scanFiles([photo]));
  expect(files[0]?.source).toBe(photo);
});

test('does not replace an unreadable dropped directory with its placeholder file', async () => {
  const error = new DOMException('Access denied', 'NotAllowedError');
  const { entry, reader } = directoryEntry('card', []);
  reader.readEntries.mockImplementation((_success, reject) => reject?.(error));

  await expect(scanDrop([dropItem({ entry, file: file('card') })])).rejects.toBe(error);
});

test('propagates directory, file and handle access errors instead of returning partial scans', async () => {
  const error = new DOMException('Access denied', 'NotAllowedError');
  const { entry, reader } = directoryEntry('card', []);
  reader.readEntries.mockImplementation((_success, reject) => reject?.(error));
  await expect(scanEntry(entry)).rejects.toBe(error);
  const unreadable = fileEntry('bad.jpg');
  unreadable.file = (_success, reject) => reject?.(error);
  await expect(scanEntry(unreadable)).rejects.toBe(error);
  const handle = fileHandle('bad.jpg');
  handle.getFile = () => Promise.reject(error);
  await expect(scanHandle(handle)).rejects.toBe(error);
  await expect(scanDrop([dropItem({ handle: Promise.reject(error) })])).rejects.toBe(error);
});
