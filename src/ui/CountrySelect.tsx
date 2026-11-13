import { useId, useState } from 'preact/hooks';
import countries from '../../models/labels/countries.json';
import timeZones from '../../models/labels/tz-country.json';
import { countryGuess } from '../core/countryGuess';

const countryOptions = countries.toSorted((a, b) => a.name.localeCompare(b.name));

/** Resolves the browser's zone before the selector has a value, so the guess can reach the pipeline. */
export function countryForTimeZone(timeZone: string): string | undefined {
  return countryGuess(timeZone, timeZones.zones);
}

export type CountrySelectProps = {
  value?: string | undefined;
  onChange: (country: string | undefined) => void;
  timeZone?: string | undefined;
  /** Says when a change of country cannot relabel what is shown. */
  note?: string | undefined;
};

/**
 * Lets the guess stand until the user picks a country; the caller owns whether that choice is
 * persisted. Choosing "Anywhere" also overrides the guess for the rest of the session.
 */
export function CountrySelect({ value, onChange, timeZone, note }: CountrySelectProps) {
  const [chosen, setChosen] = useState(false);
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const guessed = countryForTimeZone(zone);
  const selected = chosen ? value : (value ?? guessed);
  const guessedHere = !chosen && value === undefined && guessed !== undefined;
  const hint = useId();
  const noteId = useId();
  const describedBy =
    [guessedHere ? hint : '', note === undefined ? '' : noteId].filter(Boolean).join(' ') ||
    undefined;

  return (
    <span>
      <label>
        Country
        <select
          aria-describedby={describedBy}
          value={selected ?? ''}
          onChange={(event) => {
            const country = event.currentTarget.value || undefined;
            setChosen(true);
            onChange(country);
          }}
        >
          <option value="">Anywhere (no geographic filter)</option>
          {countryOptions.map((country) => (
            <option key={country.alpha3} value={country.alpha3}>
              {country.alpha3} - {country.name}
            </option>
          ))}
        </select>
      </label>
      {guessedHere && <span id={hint}> Guessed from your time zone</span>}
      {note !== undefined && <span id={noteId}> {note}</span>}
    </span>
  );
}
