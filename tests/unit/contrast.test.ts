import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tokens = readFileSync(new URL('../../src/ui/styles/tokens.css', import.meta.url), 'utf8');

function token(name: string): string {
  const match = tokens.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`));
  if (!match?.[1]) throw new Error(`no colour token --${name}`);
  return match[1];
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

// Every text colour against every surface it is set on; WCAG AA for body text is 4.5:1.
const PAIRS: [text: string, ground: string][] = [
  ['ink', 'ground'],
  ['ink-soft', 'ground'],
  ['ink-faint', 'ground'],
  ['tally', 'ground'],
  ['ink-soft', 'raised'],
  ['ink-faint', 'raised'],
  ['tally', 'raised'],
  ['on-tally', 'tally'],
  ['film-ink', 'film'],
  ['danger', 'danger-wash'],
];

describe('colour tokens', () => {
  it.each(PAIRS)('%s on %s reads at AA', (text, ground) => {
    expect(contrast(token(text), token(ground))).toBeGreaterThanOrEqual(4.5);
  });

  it('measures the reference pair the way WCAG does', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });
});
