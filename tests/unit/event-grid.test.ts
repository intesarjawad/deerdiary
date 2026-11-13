import { expect, test } from 'vitest';
import { formatBurstTime, formatCameraTime } from '../../src/ui/EventGrid';

test.each([
  [Date.UTC(2026, 0, 1, 2, 30), 'Jan 1, 2026, 2:30 AM'],
  [Date.UTC(2026, 11, 31, 23, 5), 'Dec 31, 2026, 11:05 PM'],
  [Date.UTC(2026, 6, 4, 12, 0), 'Jul 4, 2026, 12:00 PM'],
])('camera reading %i formats as %s without a timezone shift', (wallClockMs, expected) => {
  expect(formatCameraTime(wallClockMs)).toBe(expected);
});

test('a burst caption is short, yearless and on one line', () => {
  expect(formatBurstTime(Date.UTC(2011, 6, 5, 14, 25))).toBe('Jul 5 · 2:25 PM');
});
