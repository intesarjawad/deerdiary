import fc from 'fast-check';
import { expect, test } from 'vitest';
import { activityLine, hourBins } from '../../src/core/clock';
import { groupEvents } from '../../src/core/events';
import { independentDetections } from '../../src/core/independence';
import { activityWallClockTimes, wallClockDateRange } from '../../src/core/time';
import type { PhotoResult } from '../../src/core/types';

const propertyOptions = { seed: 20261104, numRuns: 200 };
const sum = (counts: readonly number[]) => counts.reduce((total, count) => total + count, 0);
const binsAt = (hours: readonly number[]) => hourBins(hours.map((h) => Date.UTC(2026, 0, 1, h)));

test.each([
  [[23, 0, 1, 8, 12], { kind: 'peak', startHour: 23, endHour: 1 }],
  [[2, 2, 2, 8, 8, 8], { kind: 'peak', startHour: 2, endHour: 2 }],
  [[2, 3, 4, 5, 12, 16, 20], { kind: 'peak', startHour: 2, endHour: 5 }],
  [[2, 3, 4, 5, 6, 12, 16, 20, 22], { kind: 'allHours' }],
  [[2, 2, 2, 2], { kind: 'none' }],
  [[2, 2, 2, 2, 2], { kind: 'peak', startHour: 2, endHour: 2 }],
  [[], { kind: 'none' }],
])('activity line for %j', (hours, expected) => {
  expect(activityLine(binsAt(hours))).toEqual(expected);
});

test('flat bins have no named peak', () => {
  expect(activityLine(Array.from({ length: 24 }, () => 1))).toEqual({ kind: 'allHours' });
});

test('uses UTC wall-clock hours, including the spring DST gap', () => {
  const bins = hourBins([Date.UTC(2026, 2, 8, 2, 30), Date.UTC(2026, 10, 1, 1, 30)]);
  expect(bins[2]).toBe(1);
  expect(bins[1]).toBe(1);
  expect(hourBins([])).toEqual(Array.from({ length: 24 }, () => 0));
});

test('reset-clock results retain events and independence while excluded from calendar statistics', () => {
  const photos: PhotoResult[] = [2000, 2026].map((year) => ({
    path: `${year}/a.jpg`,
    time: {
      wallClockMs: Date.UTC(year, 0, 1),
      wallClockHour: 0,
      timeSource: 'exif',
      offsetTimeOriginal: null,
      clockStatus: year === 2000 ? 'suspect' : 'ok',
    },
    detections: [
      {
        category: '1',
        conf: 0.9,
        bbox: [0, 0, 1, 1],
        processed_classification: { class: 'id;;;;;;animal', score: 1, source: 'detector' },
      },
    ],
  }));
  const events = groupEvents(photos);
  const detections = independentDetections(events, 30);
  expect(events).toHaveLength(2);
  expect(detections).toHaveLength(2);
  const times = detections.map((detection) => detection.time);
  const bins = hourBins(activityWallClockTimes(times));
  expect(sum(bins)).toBe(1);
  expect(activityLine(bins)).toEqual({ kind: 'none' });
  expect(wallClockDateRange(times)).toEqual({
    first: Date.UTC(2026, 0, 1),
    last: Date.UTC(2026, 0, 1),
  });
});

test('hour bins conserve every camera reading', () => {
  fc.assert(
    fc.property(fc.array(fc.integer({ min: -2_000_000_000, max: 2_000_000_000 })), (seconds) => {
      const bins = hourBins(seconds.map((second) => second * 1000));
      expect(bins).toHaveLength(24);
      expect(sum(bins)).toBe(seconds.length);
    }),
    propertyOptions,
  );
});

test('named peaks hold half the detections and span at most four hours', () => {
  fc.assert(
    fc.property(fc.array(fc.integer({ min: 0, max: 23 }), { maxLength: 150 }), (hours) => {
      const bins = binsAt(hours);
      const result = activityLine(bins);
      if (sum(bins) < 5) expect(result).toEqual({ kind: 'none' });
      if (result.kind === 'peak') {
        const width = ((result.endHour - result.startHour + 24) % 24) + 1;
        expect(width).toBeLessThanOrEqual(4);
        expect(
          sum(
            Array.from(
              { length: width },
              (_, offset) => bins[(result.startHour + offset) % 24] ?? 0,
            ),
          ),
        ).toBeGreaterThanOrEqual(sum(bins) / 2);
      }
    }),
    propertyOptions,
  );
});
