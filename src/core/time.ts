// Trail cameras with factory-reset clocks should not contribute calendar dates.
export const CLOCK_MIN_VALID_MS = Date.UTC(2010, 0, 1);
// UTC+14 cameras can read 26 hours ahead of viewers in UTC-12.
export const CLOCK_FUTURE_TOLERANCE_MS = 26 * 3_600_000;

export type ClockStatus = 'ok' | 'suspect';
export type CameraTime = {
  wallClockMs: number;
  wallClockHour: number;
  timeSource: 'exif' | 'file';
  offsetTimeOriginal: string | null;
  clockStatus: ClockStatus;
};

/** Classifies camera readings against the drop's wall clock, never an instant. */
export function clockStatus(wallClockMs: number, dropWallClockMs: number): ClockStatus {
  return wallClockMs < CLOCK_MIN_VALID_MS ||
    wallClockMs > dropWallClockMs + CLOCK_FUTURE_TOLERANCE_MS
    ? 'suspect'
    : 'ok';
}

/** Encodes a file instant as the viewer's wall clock, using its historical offset. */
export function fileWallClockMs(mtimeMs: number): number {
  return mtimeMs - new Date(mtimeMs).getTimezoneOffset() * 60_000;
}

/** Parses EXIF components without timezone conversion or calendar normalization. */
export function parseExifWallClockMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  )
    return null;
  const date = new Date(0);
  // setUTCFullYear preserves years 0000..0099, unlike Date.UTC's 1900 offset.
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  )
    return null;
  return date.getTime();
}

/** Selects calendar-eligible readings without discarding the original photo results. */
export function activityWallClockTimes(times: readonly CameraTime[]): number[] {
  return times.filter((time) => time.clockStatus === 'ok').map((time) => time.wallClockMs);
}

/** Returns the eligible first and last camera readings, or null for no valid clocks. */
export function wallClockDateRange(
  times: readonly CameraTime[],
): { first: number; last: number } | null {
  let first = Infinity;
  let last = -Infinity;
  for (const time of times) {
    if (time.clockStatus !== 'ok') continue;
    first = Math.min(first, time.wallClockMs);
    last = Math.max(last, time.wallClockMs);
  }
  return first === Infinity ? null : { first, last };
}

/** Milliseconds that JavaScript can format as a valid Date. */
export function isDateMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(new Date(value).getTime());
}

/** Validates session imports and persisted camera readings before any view formats them. */
export function isCameraTime(value: unknown): value is CameraTime {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return (
    'wallClockMs' in value &&
    isDateMs(value.wallClockMs) &&
    'wallClockHour' in value &&
    typeof value.wallClockHour === 'number' &&
    Number.isInteger(value.wallClockHour) &&
    value.wallClockHour >= 0 &&
    value.wallClockHour < 24 &&
    'timeSource' in value &&
    (value.timeSource === 'exif' || value.timeSource === 'file') &&
    'offsetTimeOriginal' in value &&
    (value.offsetTimeOriginal === null || typeof value.offsetTimeOriginal === 'string') &&
    'clockStatus' in value &&
    (value.clockStatus === 'ok' || value.clockStatus === 'suspect')
  );
}
