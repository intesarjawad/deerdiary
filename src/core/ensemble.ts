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

import { geofenceAnimal } from './geofence';
import {
  Classification,
  type Classifications,
  classificationEntries,
  DEFAULT_MAX_CLASSIFICATIONS_PER_DETECTION,
  ENSEMBLE_THRESHOLDS,
  type EnsembleContext,
  NUM_CLASSIFICATIONS_FOR_ENSEMBLE,
  type ProcessedClassification,
} from './labels';
import { rollUp } from './rollup';

export type EnsembleDetection = { label: string; conf: number };
export type EnsembleRules = {
  geofence: typeof geofenceAnimal;
  rollUp: typeof rollUp;
};

/** Combine one detection with its ranked top-five classifier output. */
export function combine(
  detection: EnsembleDetection,
  raw: Classifications,
  context: EnsembleContext,
  rules: EnsembleRules = { geofence: geofenceAnimal, rollUp },
): ProcessedClassification {
  const top = classificationEntries(raw)[0];
  if (!top) throw new Error('Expected a top classification');
  const [label, score] = top;
  const result = (value: string, confidence: number, source: 'detector' | 'classifier') => ({
    class: value,
    score: confidence,
    source,
  });
  if (detection.label === 'human') {
    if (detection.conf > ENSEMBLE_THRESHOLDS.strongDetection)
      return result(Classification.HUMAN, detection.conf, 'detector');
    if (
      detection.conf > ENSEMBLE_THRESHOLDS.supportingDetection &&
      (label === Classification.HUMAN || label === Classification.VEHICLE) &&
      score > ENSEMBLE_THRESHOLDS.humanClassification
    ) {
      return result(Classification.HUMAN, score, 'classifier');
    }
  }
  if (detection.label === 'vehicle') {
    if (
      detection.conf > ENSEMBLE_THRESHOLDS.supportingDetection &&
      label === Classification.HUMAN &&
      score > ENSEMBLE_THRESHOLDS.humanClassification
    ) {
      return result(Classification.HUMAN, score, 'classifier');
    }
    if (detection.conf > ENSEMBLE_THRESHOLDS.strongDetection)
      return result(Classification.VEHICLE, detection.conf, 'detector');
    if (
      detection.conf > ENSEMBLE_THRESHOLDS.supportingDetection &&
      label === Classification.VEHICLE &&
      score > ENSEMBLE_THRESHOLDS.vehicleClassification
    ) {
      return result(Classification.VEHICLE, score, 'classifier');
    }
  }
  if (
    label === Classification.BLANK &&
    ((detection.conf < ENSEMBLE_THRESHOLDS.supportingDetection &&
      score > ENSEMBLE_THRESHOLDS.blankClassification) ||
      score > ENSEMBLE_THRESHOLDS.certainBlank)
  ) {
    return result(Classification.BLANK, score, 'classifier');
  }
  if (
    label !== Classification.BLANK &&
    label !== Classification.HUMAN &&
    label !== Classification.VEHICLE &&
    (score > ENSEMBLE_THRESHOLDS.strongAnimalClassification ||
      (score > ENSEMBLE_THRESHOLDS.animalClassification &&
        detection.label === 'animal' &&
        detection.conf > ENSEMBLE_THRESHOLDS.supportingDetection))
  ) {
    return rules.geofence(raw, context);
  }
  const rolled = rules.rollUp(raw, context);
  if (rolled) return rolled;
  if (
    detection.label === 'animal' &&
    detection.conf > ENSEMBLE_THRESHOLDS.animalDetectionFallback
  ) {
    return result(Classification.ANIMAL, detection.conf, 'detector');
  }
  return result(Classification.UNKNOWN, score, 'classifier');
}

export function combinePredictions(
  detections: readonly EnsembleDetection[],
  classifications: readonly Classifications[],
  context: EnsembleContext,
  rules?: EnsembleRules,
): ProcessedClassification[] {
  if (detections.length !== classifications.length) {
    throw new Error('Expected one detection per classification');
  }
  return detections.map((detection, index) => {
    const raw = classifications[index];
    if (!raw) throw new Error('Missing classification');
    return combine(detection, raw, context, rules);
  });
}

export type RawDetection = EnsembleDetection & {
  category: string;
  bbox: readonly number[];
  raw_classifications?: Classifications;
  processed_classification?: ProcessedClassification;
};
type ImageInput = {
  filepath?: string;
  detections?: readonly RawDetection[];
  failures?: readonly string[];
};
type Geolocation = {
  country?: string;
  admin1_region?: string;
  latitude?: number;
  longitude?: number;
};
export type EnsembleImage = Geolocation & {
  filepath: string;
  model_version: string;
  detections?: readonly RawDetection[];
  failures?: readonly string[];
};
export type ImageEnsembleInput = {
  filepaths: readonly string[];
  classifierResults: Readonly<Record<string, ImageInput>>;
  detectorResults: Readonly<Record<string, ImageInput>>;
  geolocationResults: Readonly<Record<string, Geolocation>>;
  partialPredictions?: Readonly<Record<string, EnsembleImage>>;
  maxClassificationsPerDetection?: number | null;
};
type PredictionCombiner = typeof combinePredictions;

function topClasses(raw: Classifications, count: number | null): Classifications {
  if (count === null) return { ...raw };
  return { ...raw, classes: raw.classes.slice(0, count), scores: raw.scores.slice(0, count) };
}

function checkMatchingDetections(
  filepath: string,
  classified: readonly RawDetection[],
  detected: readonly RawDetection[],
): void {
  if (
    classified.length !== detected.length ||
    classified.some((det, index) => {
      const other = detected[index];
      return (
        !other ||
        det.category !== other.category ||
        det.bbox.length !== other.bbox.length ||
        det.bbox.some((value, coordinate) => {
          const expected = other.bbox[coordinate];
          return (
            expected === undefined ||
            Math.abs(value - expected) >
              Math.max(1e-4, 1e-9 * Math.max(Math.abs(value), Math.abs(expected)))
          );
        })
      );
    })
  )
    throw new Error(`Classifications for ${filepath} were computed on different detections`);
}

/** Pair crop or whole-image outputs, preserving failures and detection order. */
export function combineImages(
  input: ImageEnsembleInput,
  context: EnsembleContext,
  modelVersion: string,
  predictionCombiner: PredictionCombiner = combinePredictions,
): EnsembleImage[] {
  const limit =
    input.maxClassificationsPerDetection === undefined
      ? DEFAULT_MAX_CLASSIFICATIONS_PER_DETECTION
      : input.maxClassificationsPerDetection;
  return input.filepaths.map((filepath) => {
    const partial = input.partialPredictions?.[filepath];
    if (partial) return partial;
    const classifier = input.classifierResults[filepath];
    const detector = input.detectorResults[filepath];
    const geolocation = input.geolocationResults[filepath];
    const classified = classifier && !classifier.failures ? classifier.detections : undefined;
    const detected = detector && !detector.failures ? detector.detections : undefined;
    const failures: string[] = [];
    if (!classified) failures.push('CLASSIFIER');
    if (!detected) failures.push('DETECTOR');
    if (!geolocation) failures.push('GEOLOCATION');
    let output: RawDetection[] | undefined;
    const pairs: { index: number; detection: EnsembleDetection; raw: Classifications }[] = [];
    const whole = classified?.[0];
    if (whole?.category === '0') {
      output = [{ ...whole }];
      if (detected) {
        output.push(...detected.map((det) => ({ ...det })));
        if (whole.raw_classifications) {
          pairs.push({
            index: 0,
            detection: detected[0] ?? { label: 'animal', conf: 0 },
            raw: whole.raw_classifications,
          });
        }
      }
    } else if (detected) {
      if (classified) {
        checkMatchingDetections(filepath, classified, detected);
        output = classified.map((det) => ({ ...det }));
        output.forEach((det, index) => {
          if (det.raw_classifications)
            pairs.push({ index, detection: det, raw: det.raw_classifications });
        });
      } else output = detected.map((det) => ({ ...det }));
    }
    if (pairs.length > 0 && output) {
      const processed = predictionCombiner(
        pairs.map((pair) => pair.detection),
        pairs.map((pair) => topClasses(pair.raw, NUM_CLASSIFICATIONS_FOR_ENSEMBLE)),
        { ...context, country: geolocation?.country, admin1Region: geolocation?.admin1_region },
      );
      for (const [index, pair] of pairs.entries()) {
        const det = output[pair.index];
        const result = processed[index];
        if (!det || !result) throw new Error('Missing processed classification');
        det.processed_classification = result;
      }
    }
    for (const det of output ?? []) {
      if (det.raw_classifications)
        det.raw_classifications = topClasses(det.raw_classifications, limit);
    }
    return {
      filepath,
      ...geolocation,
      ...(failures.length > 0 ? { failures } : {}),
      ...(output ? { detections: output } : {}),
      model_version: modelVersion,
    };
  });
}
