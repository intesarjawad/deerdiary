import { expect, test } from 'vitest';
import { countryForTimeZone } from '../../src/ui/CountrySelect';

test('resolves a known browser zone to the country it implies', () => {
  expect(countryForTimeZone('America/Chicago')).toBe('USA');
  expect(countryForTimeZone('Europe/London')).toBe('GBR');
});

test('leaves UTC and an unknown zone without a country', () => {
  expect(countryForTimeZone('Etc/UTC')).toBeUndefined();
  expect(countryForTimeZone('Mars/Olympus_Mons')).toBeUndefined();
});
