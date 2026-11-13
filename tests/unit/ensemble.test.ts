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

import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { combine, combineImages, combinePredictions } from '../../src/core/ensemble';
import { geofenceAnimal, shouldGeofence } from '../../src/core/geofence';
import {
  Classification,
  type Classifications,
  type EnsembleContext,
  type GeofenceMap,
  type ProcessedClassification,
  TAXONOMY_LEVELS,
} from '../../src/core/labels';
import { rollUp } from '../../src/core/rollup';
import { getAncestorAtLevel, getFullClassString, loadTaxonomy } from '../../src/core/taxonomy';
import assets from '../golden/ensemble_assets.json';
import upstream from '../golden/ensemble_upstream.json';
import gbr from '../golden/speciesnet_cli.gbr.json';
import none from '../golden/speciesnet_cli.none.json';
import raw from '../golden/speciesnet_cli.raw.json';
import usa from '../golden/speciesnet_cli.usa.json';

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('Missing test input');
  return value;
}

function tuple(result: ProcessedClassification | undefined) {
  return result ? [result.class, result.score, result.source] : null;
}

const unpack = (value: string) => gunzipSync(Buffer.from(value, 'base64')).toString('utf8');
const taxonomy = loadTaxonomy(unpack(assets.taxonomyGzip));
const geofence: GeofenceMap = assets.geofence;

describe('pinned upstream cases', () => {
  for (const [index, vector] of upstream.cases.entries()) {
    it(`${vector.test} case ${index}`, () => {
      const input = vector.input;
      const maps = required(upstream.contexts[vector.context]);
      const context: EnsembleContext = {
        taxonomyMap: maps.taxonomy_map ?? {},
        geofenceMap: maps.geofence_map ?? {},
        country: input.country ?? undefined,
        admin1Region: input.admin1_region ?? undefined,
        enableGeofence: input.enable_geofence ?? true,
      };
      const classifications = (): Classifications => ({
        classes: required(input.labels),
        scores: required(input.scores),
      });
      const run = () => {
        switch (vector.function) {
          case 'get_ancestor_at_level':
            return (
              getAncestorAtLevel(
                required(input.label),
                required(input.taxonomy_level),
                context.taxonomyMap,
              ) ?? null
            );
          case 'get_full_class_string':
            return getFullClassString(required(input.label));
          case 'should_geofence_animal_classification':
            return shouldGeofence(required(input.label), context);
          case 'roll_up_labels_to_first_matching_level':
            return tuple(
              rollUp(
                classifications(),
                context,
                required(input.target_taxonomy_levels),
                required(input.non_blank_threshold),
              ),
            );
          case 'geofence_animal_classification':
            return tuple(geofenceAnimal(classifications(), context));
          case 'combine_predictions': {
            const geofenceMock = vi.fn(
              (): ProcessedClassification => ({
                class: 'geofenced_label',
                score: 0.9,
                source: 'classifier+geofence+rollup_to_family',
              }),
            );
            const rollupMock = vi.fn((): ProcessedClassification | undefined =>
              input.roll_up_fn === 'mock_roll_up_fn_return_none'
                ? undefined
                : { class: 'rollup_label', score: 0.8, source: 'classifier+rollup_to_family' },
            );
            const result = combinePredictions(
              required(input.detections),
              required(input.classifications_list),
              context,
              {
                geofence: geofenceMock,
                rollUp: rollupMock,
              },
            );
            return result.map((item) => ({
              ...item,
              source:
                item.source === 'classifier+geofence+rollup_to_family'
                  ? 'geofence_source'
                  : item.source === 'classifier+rollup_to_family'
                    ? 'rollup_source'
                    : item.source,
            }));
          }
          case 'combine_images': {
            const mockCombiner = (
              detections: readonly { label: string; conf: number }[],
              classifications: readonly Classifications[],
            ) =>
              detections.map((det, position) => {
                const classification = required(classifications[position]);
                return {
                  class: required(classification.classes[0]),
                  score: required(classification.scores[0]),
                  source: `mock:${det.label}:${det.conf}`,
                };
              });
            // The upstream image-pairing mock reports its paired detection in the source.
            // Capture those pairs while returning a valid source to the typed core.
            const mockSources: string[] = [];
            const pairing = (
              detections: readonly { label: string; conf: number }[],
              classifications: readonly Classifications[],
            ): ProcessedClassification[] =>
              mockCombiner(detections, classifications).map((item) => {
                mockSources.push(item.source);
                return { ...item, source: 'classifier' };
              });
            const output = combineImages(
              {
                filepaths: required(input.filepaths),
                classifierResults: required(input.classifier_results),
                detectorResults: required(input.detector_results),
                geolocationResults: required(input.geolocation_results),
                ...(input.partial_predictions
                  ? { partialPredictions: input.partial_predictions }
                  : {}),
                maxClassificationsPerDetection: input.max_classifications_per_detection ?? null,
              },
              context,
              'test-version',
              vector.mock ? pairing : combinePredictions,
            );
            if (!vector.mock) return output;
            let sourceIndex = 0;
            return output.map((image) => ({
              ...image,
              ...(image.detections
                ? {
                    detections: image.detections.map((det) =>
                      det.processed_classification
                        ? {
                            ...det,
                            processed_classification: {
                              ...det.processed_classification,
                              source: required(mockSources[sourceIndex++]),
                            },
                          }
                        : det,
                    ),
                  }
                : {}),
            }));
          }
          default:
            throw new Error(`Unknown vector function ${vector.function}`);
        }
      };
      if (vector.error) expect(run).toThrow();
      else expect(run()).toEqual(vector.expected);
    });
  }
});

describe('CLI raw capture parity', () => {
  for (const [country, golden] of [
    [undefined, none],
    ['USA', usa],
    ['GBR', gbr],
  ] as const) {
    it(`matches all detections for ${country ?? 'no country'}`, () => {
      let detections = 0;
      let classified = 0;
      for (const image of raw.predictions) {
        const reference = required(
          golden.predictions.find((item) => item.filepath === image.filepath),
        );
        expect(image.detections).toHaveLength(reference.detections.length);
        for (const [index, detection] of image.detections.entries()) {
          detections++;
          const expected = required(reference.detections[index]);
          if (!detection.raw_classifications) {
            expect(expected.processed_classification).toBeUndefined();
            continue;
          }
          classified++;
          const result = combine(detection, detection.raw_classifications, {
            country,
            taxonomyMap: taxonomy,
            geofenceMap: geofence,
          });
          const processed = required(expected.processed_classification);
          expect(result.class).toBe(processed.class);
          expect(result.source).toBe(processed.source);
          expect(Math.abs(result.score - processed.score)).toBeLessThanOrEqual(1e-6);
        }
      }
      expect(detections).toBe(92);
      expect(classified).toBe(38);
    });
  }
});

describe('upstream companion-asset coverage', () => {
  const labels = unpack(assets.classifierLabelsGzip).trim().split('\n');
  const geofenceKeys = new Set(unpack(assets.geofenceKeysGzip).split('\n'));

  it('preserves taxonomy special labels and checks every classifier ancestor', () => {
    for (const label of [Classification.HUMAN, Classification.ANIMAL]) {
      expect(taxonomy[getFullClassString(label)]).toBe(label);
    }
    expect(taxonomy[getFullClassString(Classification.UNKNOWN)]).toBeUndefined();
    const missing = new Set<string>();
    for (const label of labels) {
      if (
        [Classification.BLANK, Classification.VEHICLE, Classification.UNKNOWN].some(
          (item) => item === label,
        )
      )
        continue;
      const parts = label.split(';');
      let maximumLevel = 0;
      for (let i = 1; i <= 5; i++) if (parts[i]) maximumLevel = i;
      for (const [index, level] of [...TAXONOMY_LEVELS].reverse().entries()) {
        const ancestor = getAncestorAtLevel(label, level, taxonomy);
        if (index > maximumLevel) expect(ancestor).toBeUndefined();
        else if (!ancestor)
          missing.add(
            [...parts.slice(1, index + 1), ...Array<string>(5 - index).fill('')].join(';'),
          );
      }
    }
    expect([...missing].sort()).toEqual(assets.missingTaxonomyAncestors);
  });

  it('preserves geographic special labels and checks every classifier ancestor', () => {
    for (const label of [
      Classification.BLANK,
      Classification.ANIMAL,
      Classification.VEHICLE,
      Classification.UNKNOWN,
    ]) {
      expect(geofenceKeys.has(getFullClassString(label))).toBe(false);
    }
    expect(geofenceKeys.has(getFullClassString(Classification.HUMAN))).toBe(true);
    const missing = new Set<string>();
    for (const label of labels) {
      if (
        [
          Classification.BLANK,
          Classification.ANIMAL,
          Classification.VEHICLE,
          Classification.UNKNOWN,
        ].some((item) => item === label)
      )
        continue;
      const parts = label.split(';');
      for (let index = 1; index <= 5; index++) {
        const ancestor = [...parts.slice(1, index + 1), ...Array<string>(5 - index).fill('')].join(
          ';',
        );
        if (!geofenceKeys.has(ancestor)) missing.add(ancestor);
      }
    }
    expect([...missing].sort()).toEqual(assets.missingGeofenceAncestors);
  });
});
