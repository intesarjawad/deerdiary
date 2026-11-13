import { expect, test } from 'vitest';
import { combine, combineImages } from '../../src/core/ensemble';
import { shouldGeofence } from '../../src/core/geofence';
import { Classification, type EnsembleContext } from '../../src/core/labels';

const context: EnsembleContext = { taxonomyMap: {}, geofenceMap: {} };
const above = (value: number) => value + Number.EPSILON;

const thresholds = [
  {
    label: 'human',
    confidence: 0.7,
    top: Classification.VEHICLE,
    score: 0.1,
    expected: Classification.HUMAN,
    source: 'detector',
    dimension: 'detection',
  },
  {
    label: 'human',
    confidence: 0.2,
    top: Classification.VEHICLE,
    score: 0.7,
    expected: Classification.HUMAN,
    source: 'classifier',
    dimension: 'detection',
  },
  {
    label: 'human',
    confidence: 0.3,
    top: Classification.HUMAN,
    score: 0.5,
    expected: Classification.HUMAN,
    source: 'classifier',
    dimension: 'classification',
  },
  {
    label: 'vehicle',
    confidence: 0.7,
    top: Classification.BLANK,
    score: 0.1,
    expected: Classification.VEHICLE,
    source: 'detector',
    dimension: 'detection',
  },
  {
    label: 'vehicle',
    confidence: 0.3,
    top: Classification.VEHICLE,
    score: 0.4,
    expected: Classification.VEHICLE,
    source: 'classifier',
    dimension: 'classification',
  },
  {
    label: 'animal',
    confidence: 0.5,
    top: Classification.BLANK,
    score: 0.1,
    expected: Classification.ANIMAL,
    source: 'detector',
    dimension: 'detection',
  },
  {
    label: 'animal',
    confidence: 0.3,
    top: Classification.BLANK,
    score: 0.99,
    expected: Classification.BLANK,
    source: 'classifier',
    dimension: 'classification',
  },
];

for (const vector of thresholds) {
  test(`strict ${vector.label} ${vector.dimension} boundary at ${vector.dimension === 'detection' ? vector.confidence : vector.score}`, () => {
    const detection = { label: vector.label, conf: vector.confidence };
    const raw = { classes: [vector.top], scores: [vector.score] };
    expect(combine(detection, raw, context).class).toBe(Classification.UNKNOWN);
    const result = combine(
      {
        ...detection,
        conf: vector.dimension === 'detection' ? above(vector.confidence) : vector.confidence,
      },
      {
        ...raw,
        scores: [vector.dimension === 'classification' ? above(vector.score) : vector.score],
      },
      context,
    );
    expect(result.class).toBe(vector.expected);
    expect(result.source).toBe(vector.source);
  });
}

test('blank confidence uses a strict less-than detection threshold', () => {
  const raw = { classes: [Classification.BLANK], scores: [0.8] };
  expect(combine({ label: 'animal', conf: 0.2 }, raw, context).class).toBe(Classification.UNKNOWN);
  expect(combine({ label: 'animal', conf: 0.2 - Number.EPSILON }, raw, context).class).toBe(
    Classification.BLANK,
  );
});

test('animal classification thresholds retain strict comparisons', () => {
  const animal = 'id;mammalia;carnivora;felidae;panthera;leo;lion';
  for (const [score, label, conf] of [
    [0.8, 'human', 0.1],
    [0.65, 'animal', 0.3],
  ] as const) {
    expect(combine({ label, conf }, { classes: [animal], scores: [score] }, context).class).toBe(
      Classification.UNKNOWN,
    );
    expect(
      combine({ label, conf }, { classes: [animal], scores: [above(score)] }, context).class,
    ).toBe(animal);
  }
});

test('invalid country and region codes fail when geographic filtering is active', () => {
  expect(() => shouldGeofence(Classification.HUMAN, { ...context, country: 'US' })).toThrow(
    'Invalid country',
  );
  expect(() =>
    shouldGeofence(Classification.HUMAN, { ...context, country: 'USA', admin1Region: 'CAL' }),
  ).toThrow('Invalid region');
  expect(
    shouldGeofence(Classification.HUMAN, { ...context, country: 'US', enableGeofence: false }),
  ).toBe(false);
});

test('image ensembling limits reported classes without mutating raw results', () => {
  const detection = { label: 'human', conf: 0.9, category: '2', bbox: [0, 0, 1, 1] };
  const raw = {
    classes: [Classification.HUMAN, Classification.BLANK, Classification.VEHICLE],
    scores: [0.7, 0.2, 0.1],
  };
  const input = {
    filepaths: ['photo.jpg'],
    classifierResults: {
      'photo.jpg': { detections: [{ ...detection, raw_classifications: raw }] },
    },
    detectorResults: { 'photo.jpg': { detections: [detection] } },
    geolocationResults: { 'photo.jpg': {} },
  };
  const original = structuredClone(input);
  const output = combineImages(input, context, 'test');
  expect(output[0]?.detections?.[0]?.raw_classifications?.classes).toEqual(raw.classes.slice(0, 2));
  expect(output[0]?.detections?.[0]?.processed_classification).toEqual({
    class: Classification.HUMAN,
    score: 0.9,
    source: 'detector',
  });
  expect(input).toEqual(original);
});
