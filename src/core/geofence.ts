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

import {
  Classification,
  type Classifications,
  classificationEntries,
  type EnsembleContext,
  type ProcessedClassification,
} from './labels';
import { rollUp } from './rollup';
import { getFullClassString } from './taxonomy';

export function shouldGeofence(label: string, context: EnsembleContext): boolean {
  const { country, admin1Region, geofenceMap, enableGeofence = true } = context;
  if (!enableGeofence || !country) return false;
  if (country.length !== 3) throw new Error(`Invalid country code ${country}`);
  if (admin1Region && admin1Region.length !== 2) {
    throw new Error(`Invalid region code ${admin1Region}`);
  }
  const rule = geofenceMap[getFullClassString(label)];
  if (!rule) return false;
  if (rule.allow && Object.keys(rule.allow).length > 0) {
    const regions = rule.allow[country];
    if (!regions) return true;
    if (admin1Region && regions.length > 0 && !regions.includes(admin1Region)) return true;
  }
  const blocked = rule.block?.[country];
  return (
    blocked !== undefined &&
    (blocked.length === 0 || Boolean(admin1Region && blocked.includes(admin1Region)))
  );
}

export function geofenceAnimal(
  raw: Classifications,
  context: EnsembleContext,
): ProcessedClassification {
  const top = classificationEntries(raw)[0];
  if (!top) throw new Error('Expected a top classification');
  const [label, score] = top;
  if (!shouldGeofence(label, context)) return { class: label, score, source: 'classifier' };
  // Upstream's epsilon makes a single top label sufficient for a geographic rollup.
  const rollup = rollUp(raw, context, ['family', 'order', 'class', 'kingdom'], score - 1e-10);
  if (rollup) {
    const level = rollup.source.replace('classifier+rollup_to_', '');
    const target = ['species', 'genus', 'family', 'order', 'class', 'kingdom'] as const;
    const taxonomyLevel = target.find((item) => item === level);
    if (!taxonomyLevel) throw new Error(`Invalid rollup source ${rollup.source}`);
    return { ...rollup, source: `classifier+geofence+rollup_to_${taxonomyLevel}` };
  }
  return { class: Classification.UNKNOWN, score, source: 'classifier+geofence+rollup_failed' };
}
