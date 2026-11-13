import { expect, test } from 'vitest';
import { formatActivity } from '../../src/ui/SpeciesCard';

test.each([
  [{ kind: 'none' }, null],
  [{ kind: 'allHours' }, 'seen at all hours'],
  [{ kind: 'peak', startHour: 2, endHour: 2 }, 'mostly 2 am'],
  [{ kind: 'peak', startHour: 0, endHour: 0 }, 'mostly 12 am'],
  [{ kind: 'peak', startHour: 12, endHour: 12 }, 'mostly 12 pm'],
  [{ kind: 'peak', startHour: 15, endHour: 15 }, 'mostly 3 pm'],
  [{ kind: 'peak', startHour: 23, endHour: 1 }, 'mostly 11 pm to 1 am'],
] as const)('activity line %j', (line, expected) => {
  expect(formatActivity(line)).toBe(expected);
});
