import { expect, test } from 'vitest';

test('unit tests use New York wall-clock time across daylight saving time', () => {
  expect(new Date('2026-01-15T12:00:00Z').getHours()).toBe(7);
  expect(new Date('2026-07-15T12:00:00Z').getHours()).toBe(8);
});
