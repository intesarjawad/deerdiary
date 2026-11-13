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

import { Classification, type TaxonomyLevel, type TaxonomyMap } from './labels';

function labelParts(label: string): string[] {
  const parts = label.split(';');
  if (parts.length !== 7) throw new Error(`Expected label made of 7 parts: ${label}`);
  return parts;
}

export function getFullClassString(label: string): string {
  return labelParts(label).slice(1, 6).join(';');
}

export function getAncestorAtLevel(
  label: string,
  level: string,
  taxonomy: TaxonomyMap,
): string | undefined {
  const parts = labelParts(label);
  const lengths: Record<TaxonomyLevel, number> = {
    species: 5,
    genus: 4,
    family: 3,
    order: 2,
    class: 1,
    kingdom: 0,
  };
  const length = Object.entries(lengths).find(([name]) => name === level)?.[1];
  if (length === undefined) return undefined;
  if (length === 0) {
    if (!parts[1] && label !== Classification.ANIMAL) return undefined;
  } else if (!parts[length]) return undefined;
  return taxonomy[[...parts.slice(1, length + 1), ...Array<string>(5 - length).fill('')].join(';')];
}

export function loadTaxonomy(text: string): TaxonomyMap {
  const taxonomy: Record<string, string> = {};
  for (const row of text.split(/\r?\n/)) {
    const line = row.trim();
    if (!line) continue;
    const key = getFullClassString(line);
    taxonomy[key] = line;
  }
  for (const label of [Classification.BLANK, Classification.VEHICLE, Classification.UNKNOWN]) {
    delete taxonomy[getFullClassString(label)];
  }
  for (const label of [Classification.HUMAN, Classification.ANIMAL]) {
    taxonomy[getFullClassString(label)] = label;
  }
  return taxonomy;
}
