import type { EnsembleDetection } from './ensemble';
import {
  Classification,
  type Classifications,
  classificationEntries,
  type PredictionSource,
  TAXONOMY_LEVELS,
  type TaxonomyLevel,
} from './labels';

export type ExplainContext = {
  classification: Classifications;
  detector: EnsembleDetection;
  country?: string | undefined;
};

export function percent(score: number): string {
  return `${Math.round(score * 100)}%`;
}

/** The last label part is the common name; the generic classes carry no taxonomy. */
export function displayName(label: string): string {
  switch (label) {
    case Classification.BLANK:
      return 'blank';
    case Classification.HUMAN:
      return 'human';
    case Classification.VEHICLE:
      return 'vehicle';
    case Classification.UNKNOWN:
      return 'unknown';
    default:
      return label.split(';').at(-1) || label;
  }
}

/**
 * A name set on its own, as in a list: capitalised as a field guide sets it, and a label that
 * stops at "animal" read as an unidentified animal, the diary's own term.
 */
export function titleName(label: string): string {
  const name = displayName(label);
  return name === 'animal' ? 'Unidentified animal' : name.charAt(0).toUpperCase() + name.slice(1);
}

function geofenceName(country: string | undefined): string {
  return country ? `The ${country} geofence` : 'The geofence';
}

function rollupSentence(level: TaxonomyLevel): string {
  return `No class cleared the animal threshold on its own, so the top five were summed at ${level}.`;
}

function geofenceRollupSentence(
  level: TaxonomyLevel,
  top: readonly [string, number],
  country: string | undefined,
): string {
  return `${geofenceName(country)} blocks ${displayName(top[0])}, so the top five were summed at ${level} instead.`;
}

function geofenceFailedSentence(
  top: readonly [string, number],
  country: string | undefined,
): string {
  return `${geofenceName(country)} blocks ${displayName(top[0])} and no broader group cleared the threshold, so the label is unknown.`;
}

function ruleSentence(
  source: PredictionSource,
  context: ExplainContext,
  top: readonly [string, number],
): string {
  switch (source) {
    case 'classifier':
      return 'The top class cleared the animal threshold, so it stands as the label.';
    case 'detector':
      return "The detector's confidence was high enough, so its own label stands.";
    case 'classifier+rollup_to_species':
      return rollupSentence('species');
    case 'classifier+rollup_to_genus':
      return rollupSentence('genus');
    case 'classifier+rollup_to_family':
      return rollupSentence('family');
    case 'classifier+rollup_to_order':
      return rollupSentence('order');
    case 'classifier+rollup_to_class':
      return rollupSentence('class');
    case 'classifier+rollup_to_kingdom':
      return rollupSentence('kingdom');
    case 'classifier+geofence+rollup_to_species':
      return geofenceRollupSentence('species', top, context.country);
    case 'classifier+geofence+rollup_to_genus':
      return geofenceRollupSentence('genus', top, context.country);
    case 'classifier+geofence+rollup_to_family':
      return geofenceRollupSentence('family', top, context.country);
    case 'classifier+geofence+rollup_to_order':
      return geofenceRollupSentence('order', top, context.country);
    case 'classifier+geofence+rollup_to_class':
      return geofenceRollupSentence('class', top, context.country);
    case 'classifier+geofence+rollup_to_kingdom':
      return geofenceRollupSentence('kingdom', top, context.country);
    case 'classifier+geofence+rollup_failed':
      return geofenceFailedSentence(top, context.country);
  }
  const unreachable: never = source;
  throw new Error(`Unexpected prediction source ${unreachable}`);
}

/** Narrows an imported source string before it reaches the exhaustive sentence switch. */
export function isPredictionSource(source: string): source is PredictionSource {
  if (
    source === 'classifier' ||
    source === 'detector' ||
    source === 'classifier+geofence+rollup_failed'
  )
    return true;
  return TAXONOMY_LEVELS.some(
    (level) =>
      source === `classifier+rollup_to_${level}` ||
      source === `classifier+geofence+rollup_to_${level}`,
  );
}

/** Sentences for the "Why this label" popover: detector, classifier, then the rule that decided. */
export function explainSource(source: PredictionSource, context: ExplainContext): string[] {
  const top = classificationEntries(context.classification)[0];
  if (!top) throw new Error('Expected a top classification');
  return [
    `The detector reported ${context.detector.label} with ${percent(context.detector.conf)} confidence.`,
    `The classifier's top guess was ${displayName(top[0])} with ${percent(top[1])} confidence.`,
    ruleSentence(source, context, top),
  ];
}
