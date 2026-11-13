// Copyright 2024 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Ported from google/cameratrapai aebb5bf852238ee02dac0b82abeb36721ca5bff4.

export const Classification = {
  BLANK: 'f1856211-cfb7-4a5b-9158-c0f72fd09ee6;;;;;;blank',
  ANIMAL: '1f689929-883d-4dae-958c-3d57ab5b6c16;;;;;;animal',
  HUMAN: '990ae9dd-7a59-4344-afcb-1b7b21368000;mammalia;primates;hominidae;homo;sapiens;human',
  VEHICLE: 'e2895ed5-780b-48f6-8a11-9e27cb594511;;;;;;vehicle',
  UNKNOWN:
    'f2efdae9-efb8-48fb-8a91-eccf79ab4ffb;no cv result;no cv result;no cv result;no cv result;no cv result;no cv result',
} as const;

// Confidence thresholds from upstream combine_predictions, preserving strict comparisons.
export const ENSEMBLE_THRESHOLDS = {
  strongDetection: 0.7,
  supportingDetection: 0.2,
  humanClassification: 0.5,
  vehicleClassification: 0.4,
  blankClassification: 0.5,
  certainBlank: 0.99,
  strongAnimalClassification: 0.8,
  animalClassification: 0.65,
  animalDetectionFallback: 0.5,
} as const;
export const NUM_CLASSIFICATIONS_FOR_ENSEMBLE = 5;
export const DEFAULT_MAX_CLASSIFICATIONS_PER_DETECTION = 2;

export const TAXONOMY_LEVELS = ['species', 'genus', 'family', 'order', 'class', 'kingdom'] as const;
export type TaxonomyLevel = (typeof TAXONOMY_LEVELS)[number];
export type PredictionSource =
  | 'classifier'
  | 'detector'
  | `classifier+rollup_to_${TaxonomyLevel}`
  | `classifier+geofence+rollup_to_${TaxonomyLevel}`
  | 'classifier+geofence+rollup_failed';
export type ProcessedClassification = { class: string; score: number; source: PredictionSource };
export type Classifications = { classes: readonly string[]; scores: readonly number[] };
export type TaxonomyMap = Readonly<Record<string, string>>;
export type GeofenceMap = Readonly<
  Record<
    string,
    {
      allow?: Readonly<Record<string, readonly string[]>>;
      block?: Readonly<Record<string, readonly string[]>>;
    }
  >
>;
/** Checks the shape of a parsed geofence release before it is used as rules. */
export function isGeofenceMap(value: unknown): value is GeofenceMap {
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value).every((rule: unknown) => {
    if (typeof rule !== 'object' || rule === null) return false;
    return Object.entries(rule).every(([key, countries]: [string, unknown]) => {
      if (key !== 'allow' && key !== 'block') return false;
      return (
        typeof countries === 'object' &&
        countries !== null &&
        Object.values(countries).every(
          (regions: unknown) =>
            Array.isArray(regions) &&
            regions.every((region: unknown) => typeof region === 'string'),
        )
      );
    });
  });
}

export type EnsembleContext = {
  taxonomyMap: TaxonomyMap;
  geofenceMap: GeofenceMap;
  country?: string | undefined;
  admin1Region?: string | undefined;
  enableGeofence?: boolean | undefined;
};

/** Validate paired model outputs before applying ensemble rules. */
export function classificationEntries(
  raw: Classifications,
): readonly (readonly [string, number])[] {
  if (raw.classes.length !== raw.scores.length || raw.classes.length === 0) {
    throw new Error('Expected nonempty classes with one score per class');
  }
  return raw.classes.map((label, index) => {
    const score = raw.scores[index];
    if (score === undefined || !Number.isFinite(score) || score < 0 || score > 1) {
      throw new Error('Classification scores must be finite probabilities');
    }
    return [label, score] as const;
  });
}
