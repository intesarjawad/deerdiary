import { expect, it } from 'vitest';
import timeZones from '../../models/labels/tz-country.json';
import { countryGuess } from '../../src/core/countryGuess';

it('returns the alpha-3 code for a mapped time zone', () => {
  const table = { 'America/Chicago': 'USA', 'Europe/London': 'GBR' };
  expect(countryGuess('America/Chicago', table)).toBe('USA');
  expect(countryGuess('Europe/London', table)).toBe('GBR');
});

it('returns undefined for UTC and for a zone outside the table', () => {
  const table = { 'America/Chicago': 'USA' };
  expect(countryGuess('Etc/UTC', table)).toBeUndefined();
  expect(countryGuess('Mars/Olympus_Mons', table)).toBeUndefined();
  expect(countryGuess('america/chicago', table)).toBeUndefined();
});

it('maps zones from the shipped table to their countries', () => {
  expect(countryGuess('America/Chicago', timeZones.zones)).toBe('USA');
  expect(countryGuess('Europe/London', timeZones.zones)).toBe('GBR');
  expect(countryGuess('Etc/UTC', timeZones.zones)).toBeUndefined();
});
