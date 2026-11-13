import { expect, test, vi } from 'vitest';
import {
  activityWallClockTimes,
  CLOCK_FUTURE_TOLERANCE_MS,
  CLOCK_MIN_VALID_MS,
  clockStatus,
  parseExifWallClockMs,
  wallClockDateRange,
} from '../../src/core/time';
import { readCameraTime } from '../../src/files/exif';
import { scanFiles } from '../../src/files/scan';

const dropWallClockMs = Date.UTC(2026, 10, 1, 12);
const mtimeMs = Date.parse('2026-11-01T05:30:00Z');

// Minimal JPEG APP1 containing an IFD0 EXIF pointer and ASCII EXIF tags.
function exifJpeg(date: string, offset = '-05:00'): Uint8Array<ArrayBuffer> {
  const tags = [
    { id: 0x9003, value: `${date}\0` },
    { id: 0x9011, value: `${offset}\0` },
  ];
  const dataStart = 26 + 2 + tags.length * 12 + 4;
  const tiff = new Uint8Array(dataStart + tags.reduce((sum, tag) => sum + tag.value.length, 0));
  const view = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49]);
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  view.setUint16(8, 1, true);
  view.setUint16(10, 0x8769, true);
  view.setUint16(12, 4, true);
  view.setUint32(14, 1, true);
  view.setUint32(18, 26, true);
  view.setUint16(26, tags.length, true);
  let dataOffset = dataStart;
  for (const [index, tag] of tags.entries()) {
    const entry = 28 + index * 12;
    view.setUint16(entry, tag.id, true);
    view.setUint16(entry + 2, 2, true);
    view.setUint32(entry + 4, tag.value.length, true);
    view.setUint32(entry + 8, dataOffset, true);
    tiff.set(new TextEncoder().encode(tag.value), dataOffset);
    dataOffset += tag.value.length;
  }
  const segmentLength = 2 + 6 + tiff.length;
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe1,
    segmentLength >> 8,
    segmentLength & 0xff,
    0x45,
    0x78,
    0x69,
    0x66,
    0,
    0,
    ...tiff,
    0xff,
    0xd9,
  ]);
}

async function read(bytes: Uint8Array<ArrayBuffer>, modified = mtimeMs) {
  const [scanned] = scanFiles([new File([bytes], 'camera.jpg', { lastModified: modified })]);
  if (!scanned) throw new Error('Expected a scanned photo');
  return readCameraTime(scanned, dropWallClockMs);
}

test('preserves spring DST gap as camera hour 2 and stores the unapplied offset', async () => {
  expect(process.env.TZ).toBe('America/New_York');
  const time = await read(exifJpeg('2026:03:08 02:30:00', '+14:00'));
  expect(time).toEqual({
    wallClockMs: Date.UTC(2026, 2, 8, 2, 30),
    wallClockHour: 2,
    timeSource: 'exif',
    offsetTimeOriginal: '+14:00',
    clockStatus: 'ok',
  });
  expect(activityWallClockTimes([time]).map((ms) => new Date(ms).getUTCHours())).toEqual([2]);
});

test.each([
  ['missing EXIF', new Uint8Array([0xff, 0xd8, 0xff, 0xd9])],
  ['corrupt EXIF', exifJpeg('2026:02:30 12:00:00')],
  ['truncated EXIF', exifJpeg('2026:03:08 02:30:00').slice(0, 24)],
  ['unreadable metadata', new Uint8Array([1, 2, 3])],
])('uses file time for %s', async (_name, bytes) => {
  expect(await read(bytes)).toMatchObject({
    wallClockMs: Date.UTC(2026, 10, 1, 1, 30),
    wallClockHour: 1,
    timeSource: 'file',
    clockStatus: 'ok',
  });
});

test('both autumn 01:30 instants bin to the same wall-clock hour', async () => {
  const noExif = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const edt = await read(noExif, Date.parse('2026-11-01T01:30:00-04:00'));
  const est = await read(noExif, Date.parse('2026-11-01T01:30:00-05:00'));
  expect(edt.wallClockMs).toBe(Date.UTC(2026, 10, 1, 1, 30));
  expect(est.wallClockMs).toBe(edt.wallClockMs);
  expect([edt.wallClockHour, est.wallClockHour]).toEqual([1, 1]);
});

test.each([
  [Date.UTC(2009, 11, 31, 23, 59, 59), 'suspect'],
  [CLOCK_MIN_VALID_MS, 'ok'],
  [dropWallClockMs + CLOCK_FUTURE_TOLERANCE_MS, 'ok'],
  [dropWallClockMs + CLOCK_FUTURE_TOLERANCE_MS + 1000, 'suspect'],
] as const)('classifies reset boundary %i as %s', (time, status) => {
  expect(clockStatus(time, dropWallClockMs)).toBe(status);
});

test.each([
  '2026:13:01 00:00:00',
  '2026:01:00 00:00:00',
  '2026:01:01 24:00:00',
  '2026:01:01 00:60:00',
  '2026:01:01 00:00:60',
  'not a date',
  '',
  null,
])('rejects invalid EXIF components: %s', (value) => {
  expect(parseExifWallClockMs(value)).toBeNull();
});

test('accepts leap day and preserves factory years below 100', () => {
  expect(parseExifWallClockMs('2024:02:29 12:34:56')).toBe(Date.UTC(2024, 1, 29, 12, 34, 56));
  const ms = parseExifWallClockMs('0001:01:01 00:00:00');
  expect(ms).not.toBeNull();
  expect(new Date(ms ?? 0).getUTCFullYear()).toBe(1);
});

test('a reset camera retains its species count but contributes no activity or date range', async () => {
  const photos = [
    { species: 'deer', time: await read(exifJpeg('2000:01:01 00:00:00')) },
    { species: 'deer', time: await read(exifJpeg('2026:10:31 06:00:00')) },
    { species: 'fox', time: await read(exifJpeg('2026:11:01 03:00:00')) },
  ];
  expect(photos.filter((photo) => photo.species === 'deer')).toHaveLength(2);
  const times = photos.map((photo) => photo.time);
  const bins = Array.from(
    { length: 24 },
    (_, hour) =>
      activityWallClockTimes(times).filter((ms) => new Date(ms).getUTCHours() === hour).length,
  );
  expect(bins[0]).toBe(0);
  expect(bins[3]).toBe(1);
  expect(bins[6]).toBe(1);
  expect(bins.reduce((sum, count) => sum + count, 0)).toBe(2);
  expect(wallClockDateRange(times)).toEqual({
    first: Date.UTC(2026, 9, 31, 6),
    last: Date.UTC(2026, 10, 1, 3),
  });
  expect(wallClockDateRange([times[0]].filter((time) => time !== undefined))).toBeNull();
  expect(wallClockDateRange([])).toBeNull();
});

test('reads a scanned handle and propagates file-access failures', async () => {
  const [scanned] = scanFiles([new File([exifJpeg('2026:03:08 02:30:00')], 'camera.jpg')]);
  if (!scanned) throw new Error('Expected a scanned photo');
  const getFile = vi.fn(async () => new File([exifJpeg('2026:03:08 02:30:00')], 'camera.jpg'));
  scanned.source = {
    kind: 'file',
    name: 'camera.jpg',
    isFile: true,
    isDirectory: false,
    getFile,
    createWritable: vi.fn(),
    createSyncAccessHandle: vi.fn(),
    isSameEntry: vi.fn(),
    queryPermission: vi.fn(),
    requestPermission: vi.fn(),
  };
  expect((await readCameraTime(scanned, dropWallClockMs)).wallClockHour).toBe(2);
  getFile.mockRejectedValueOnce(new Error('Card removed'));
  await expect(readCameraTime(scanned, dropWallClockMs)).rejects.toThrow('Card removed');
});
