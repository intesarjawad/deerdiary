const HOURS_PER_DAY = 24;
// "Mostly" means at least half; wider windows and fewer sightings do not name a peak.
export const PEAK_SHARE = 0.5;
export const PEAK_MAX_HOURS = 4;
export const PEAK_MIN_DETECTIONS = 5;

export type ActivityLine =
  | { kind: 'peak'; startHour: number; endHour: number }
  | { kind: 'allHours' }
  | { kind: 'none' };

/** Bins eligible camera wall-clock readings without viewer timezone conversion. */
export function hourBins(wallClockMs: readonly number[]): readonly number[] {
  const bins = Array.from({ length: HOURS_PER_DAY }, () => 0);
  for (const ms of wallClockMs) {
    const hour = new Date(ms).getUTCHours();
    bins[hour] = (bins[hour] ?? 0) + 1;
  }
  return bins;
}

/** Finds the shortest inclusive circular window, breaking ties by earliest start. */
export function activityLine(bins: readonly number[]): ActivityLine {
  const total = bins.reduce((sum, count) => sum + count, 0);
  if (total < PEAK_MIN_DETECTIONS) return { kind: 'none' };
  for (let width = 1; width <= PEAK_MAX_HOURS; width++) {
    for (let startHour = 0; startHour < HOURS_PER_DAY; startHour++) {
      let count = 0;
      for (let offset = 0; offset < width; offset++) {
        count += bins[(startHour + offset) % HOURS_PER_DAY] ?? 0;
      }
      if (count >= total * PEAK_SHARE) {
        return { kind: 'peak', startHour, endHour: (startHour + width - 1) % HOURS_PER_DAY };
      }
    }
  }
  return { kind: 'allHours' };
}
