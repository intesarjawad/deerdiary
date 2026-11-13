// Photos are JPEG only, so the lite build's JPEG and TIFF parsers are enough.
import { parse } from 'exifr/dist/lite.esm.mjs';
import { type CameraTime, clockStatus, fileWallClockMs, parseExifWallClockMs } from '../core/time';
import type { ScannedFile } from './scan';

/** Reads camera time, falling back to file time for absent or damaged EXIF. */
export async function readCameraTime(
  scanned: ScannedFile,
  dropWallClockMs: number,
): Promise<CameraTime> {
  const file = 'getFile' in scanned.source ? await scanned.source.getFile() : scanned.source;
  const bytes = await file.arrayBuffer();
  let metadata: unknown;
  try {
    metadata = await parse(bytes, {
      // The lite build has no global pick; naming the tags on their block reads the same two.
      exif: { pick: ['DateTimeOriginal', 'OffsetTimeOriginal'] },
      gps: false,
      // Date revival would normalize nonexistent local times during the DST jump.
      reviveValues: false,
    });
  } catch {
    // Corrupt metadata must not prevent the photo itself from being processed.
    metadata = undefined;
  }
  const exifWallClockMs = parseExifWallClockMs(
    typeof metadata === 'object' && metadata !== null && 'DateTimeOriginal' in metadata
      ? metadata.DateTimeOriginal
      : undefined,
  );
  const offsetTimeOriginal =
    typeof metadata === 'object' &&
    metadata !== null &&
    'OffsetTimeOriginal' in metadata &&
    typeof metadata.OffsetTimeOriginal === 'string'
      ? metadata.OffsetTimeOriginal
      : null;
  const wallClockMs = exifWallClockMs ?? fileWallClockMs(scanned.mtimeMs);
  return {
    wallClockMs,
    wallClockHour: new Date(wallClockMs).getUTCHours(),
    timeSource: exifWallClockMs === null ? 'file' : 'exif',
    offsetTimeOriginal,
    clockStatus: clockStatus(wallClockMs, dropWallClockMs),
  };
}
