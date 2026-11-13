const ALPHA3 = /^[A-Z]{3}$/;

/** Resolves an IANA time zone through a shipped table without consulting the browser. */
export function countryGuess(
  timeZone: string,
  table: Readonly<Record<string, string>>,
): string | undefined {
  const country = table[timeZone];
  return country !== undefined && ALPHA3.test(country) ? country : undefined;
}
