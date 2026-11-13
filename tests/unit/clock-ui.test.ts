import { expect, test } from 'vitest';
import { clockReadout, nextClockHour, spokeFraction } from '../../src/ui/Clock';

test.each([
  [2, 9, '2 am: 9 detections'],
  [0, 0, '12 am: 0 detections'],
  [12, 1, '12 pm: 1 detection'],
  [13, 2, '1 pm: 2 detections'],
  [23, 1000, '11 pm: 1,000 detections'],
])('readout for hour %i with %i detections', (hour, detections, expected) => {
  expect(clockReadout(hour, detections)).toBe(expected);
});

test('arrow keys wrap around the day and Home/End jump to its ends', () => {
  expect(nextClockHour(23, 'ArrowRight')).toBe(0);
  expect(nextClockHour(0, 'ArrowLeft')).toBe(23);
  expect(nextClockHour(5, 'ArrowDown')).toBe(6);
  expect(nextClockHour(5, 'ArrowUp')).toBe(4);
  expect(nextClockHour(17, 'Home')).toBe(0);
  expect(nextClockHour(17, 'End')).toBe(23);
  expect(nextClockHour(17, 'PageDown')).toBeNull();
  expect(nextClockHour(17, 'Tab')).toBeNull();
});

test('spoke length is the count share of the busiest hour, clamped to the chart', () => {
  expect(spokeFraction(5, 10)).toBe(0.5);
  expect(spokeFraction(0, 10)).toBe(0);
  expect(spokeFraction(10, 10)).toBe(1);
  expect(spokeFraction(20, 10)).toBe(1);
  expect(spokeFraction(3, 0)).toBe(0);
  expect(spokeFraction(3, -1)).toBe(0);
});
