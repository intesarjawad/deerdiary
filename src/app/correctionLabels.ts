import type { DeerdiaryEvent } from '../core/types';
import vocabularyURL from './speciesnet-labels.txt?url';

/** SpeciesNet v4.0.3a's Apache-2.0 labels, pinned by models/manifest.json. */
export async function loadCorrectionVocabulary(): Promise<string[]> {
  const response = await fetch(vocabularyURL);
  if (!response.ok)
    throw new Error(`Could not load species names (${response.status}). Reload to try again.`);
  return (await response.text())
    .trim()
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('#'));
}

/** Includes unseen species and any labels brought in by imported predictions. */
export function correctionLabels(
  events: readonly DeerdiaryEvent[],
  corrections: Readonly<Record<string, string>> = {},
  vocabulary: readonly string[] = [],
): string[] {
  const labels = new Set<string>(vocabulary);
  for (const event of events) {
    for (const species of event.species) labels.add(species.label);
  }
  for (const label of Object.values(corrections)) labels.add(label);
  return Array.from(labels).toSorted((left, right) => left.localeCompare(right));
}
