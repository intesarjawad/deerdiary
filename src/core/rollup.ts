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

import { shouldGeofence } from './geofence';
import {
  type Classifications,
  classificationEntries,
  ENSEMBLE_THRESHOLDS,
  type EnsembleContext,
  type ProcessedClassification,
  TAXONOMY_LEVELS,
} from './labels';
import { getAncestorAtLevel } from './taxonomy';

export function rollUp(
  raw: Classifications,
  context: EnsembleContext,
  levels: readonly string[] = ['genus', 'family', 'order', 'class', 'kingdom'],
  threshold: number = ENSEMBLE_THRESHOLDS.animalClassification,
): ProcessedClassification | undefined {
  const validatedLevels = levels.map((level) => {
    const valid = TAXONOMY_LEVELS.find((value) => value === level);
    if (!valid) throw new Error('Unexpected target taxonomy level');
    return valid;
  });
  const entries = classificationEntries(raw);
  for (const level of validatedLevels) {
    const accumulated = new Map<string, number>();
    for (const [label, score] of entries) {
      const ancestor = getAncestorAtLevel(label, level, context.taxonomyMap);
      if (ancestor) accumulated.set(ancestor, (accumulated.get(ancestor) ?? 0) + score);
    }
    let best: string | undefined;
    let bestScore = 0;
    for (const [label, score] of accumulated) {
      if (score > bestScore && !shouldGeofence(label, context)) {
        best = label;
        bestScore = score;
      }
    }
    if (best && bestScore > threshold) {
      return { class: best, score: bestScore, source: `classifier+rollup_to_${level}` };
    }
  }
  return undefined;
}
