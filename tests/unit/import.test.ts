import { expect, test } from 'vitest';
import {
  applyCountry,
  COUNTRY_FIXED_NOTE,
  detectFormat,
  hasCountryFixedLabels,
  type ImportedBatch,
  importErrorMessage,
  matchPhotoPath,
  parseImport,
} from '../../src/app/import';
import { SPECIESNET_FORMAT_VERSION } from '../../src/core/speciesnetJson';

const deer = 'deer-uuid;mammalia;artiodactyla;cervidae;odocoileus;virginianus;white-tailed deer';
const fox = 'fox-uuid;mammalia;carnivora;canidae;vulpes;vulpes;red fox';

test('detects SpeciesNet by predictions and MegaDetector by images and categories', () => {
  expect(
    detectFormat({
      info: { format_version: SPECIESNET_FORMAT_VERSION },
      predictions: [
        {
          filepath: 'a.jpg',
          detections: [{ processed_classification: { class: deer, score: 0.9, source: 'x' } }],
        },
      ],
    }),
  ).toBe('speciesnet');
  expect(
    detectFormat({
      info: { format_version: '1.6' },
      images: [{ file: 'a.jpg', detections: [] }],
      detection_categories: { '1': 'animal' },
      classification_categories: { deer: deer },
    }),
  ).toBe('megadetector');
  expect(detectFormat({ info: { format_version: '1.6' } })).toBeUndefined();
});

test('imports a MegaDetector file with its two raw classes and a fixed processed label', () => {
  const imported = parseImport({
    info: { format_version: '1.6' },
    detection_categories: { '1': 'animal', '2': 'person', '3': 'vehicle' },
    classification_categories: { [deer]: deer, [fox]: fox },
    images: [
      {
        file: 'tests/golden/upstream/card/DCIM/100MEDIA/a.jpg',
        detections: [
          {
            category: '1',
            conf: 0.87,
            bbox: [0.1, 0.2, 0.3, 0.4],
            classifications: [
              [deer, 0.75],
              [fox, 0.2],
            ],
          },
        ],
      },
    ],
  });

  expect(imported).toEqual({
    ok: true,
    value: {
      format: 'megadetector',
      photos: [
        {
          path: 'tests/golden/upstream/card/DCIM/100MEDIA/a.jpg',
          detections: [
            {
              category: '1',
              label: 'animal',
              conf: 0.87,
              bbox: [0.1, 0.2, 0.3, 0.4],
              raw_classifications: { classes: [deer, fox], scores: [0.75, 0.2] },
              processed_classification: { class: deer, score: 0.75, source: 'classifier' },
            },
          ],
        },
      ],
      events: [],
      corrections: {},
      independenceIntervalMin: 30,
    },
  });
});

test('imports SpeciesNet events, corrections and the independence interval', () => {
  const imported = parseImport({
    info: { format_version: SPECIESNET_FORMAT_VERSION },
    predictions: [{ filepath: 'a.jpg' }],
    deerdiary: {
      version: 1,
      events: [{ id: 'cam@1', camera: 'cam', photos: ['a.jpg'], species: [deer] }],
      corrections: { [deer]: 'Deer' },
      independence_interval_min: 45,
    },
  });

  expect(imported).toEqual({
    ok: true,
    value: {
      format: 'speciesnet',
      photos: [{ path: 'a.jpg', detections: [] }],
      events: [{ id: 'cam@1', camera: 'cam', photos: ['a.jpg'], species: [deer] }],
      corrections: { [deer]: 'Deer' },
      independenceIntervalMin: 45,
    },
  });
});

test('reports malformed JSON and the first bad field', () => {
  expect(parseImport('{"predictions":')).toEqual({ ok: false, field: 'root' });
  expect(
    parseImport({
      info: { format_version: SPECIESNET_FORMAT_VERSION },
      predictions: [
        {
          filepath: 'a.jpg',
          detections: [{ category: '1', label: 'animal', conf: 0.9, bbox: [0, 0, 1] }],
        },
      ],
    }),
  ).toEqual({ ok: false, field: 'predictions[0].detections[0].bbox' });
});

test('matches an imported path to the dropped folder by its trailing segments', () => {
  const photos = ['card/DCIM/100MEDIA/a.jpg', 'card/DCIM/100MEDIA/b.jpg'];

  expect(matchPhotoPath('tests/golden/upstream/card/DCIM/100MEDIA/a.jpg', photos)).toBe(
    'card/DCIM/100MEDIA/a.jpg',
  );
  expect(matchPhotoPath('other/DCIM/100MEDIA/b.jpg', photos)).toBe('card/DCIM/100MEDIA/b.jpg');
  expect(matchPhotoPath('card/DCIM/100MEDIA/c.jpg', photos)).toBeUndefined();
});

const family = 'cervid-uuid;mammalia;artiodactyla;cervidae;;;';
const fixedContext = {
  taxonomyMap: { 'mammalia;artiodactyla;cervidae;;': family },
  geofenceMap: { 'mammalia;artiodactyla;cervidae;odocoileus;virginianus': { block: { GBR: [] } } },
};

function speciesNetFile(classes: readonly string[], scores: readonly number[]) {
  return {
    info: { format_version: SPECIESNET_FORMAT_VERSION },
    predictions: [
      {
        filepath: 'a.jpg',
        detections: [
          {
            category: '1',
            label: 'animal',
            conf: 0.9,
            bbox: [0, 0, 1, 1],
            raw_classifications: { classes, scores },
            processed_classification: { class: deer, score: scores[0], source: 'classifier' },
          },
        ],
      },
    ],
  };
}

function importedBatch(input: unknown): ImportedBatch {
  const imported = parseImport(input);
  if (!imported.ok) throw new Error(`Fixture rejected at ${imported.field}`);
  return imported.value;
}

test('a country change relabels a detection that has five raw classes', () => {
  const batch = importedBatch(
    speciesNetFile(
      [deer, fox, 'a;m;o;f;g;s;a', 'b;m;o;f;g;s;b', 'c;m;o;f;g;s;c'],
      [0.9, 0.03, 0.03, 0.02, 0.01],
    ),
  );

  expect(hasCountryFixedLabels(batch)).toBe(false);
  const moved = applyCountry(batch, { ...fixedContext, country: 'GBR' });
  expect(moved.photos[0]?.detections[0]?.processed_classification).toEqual({
    class: family,
    score: 0.9,
    source: 'classifier+geofence+rollup_to_family',
  });
  const home = applyCountry(batch, { ...fixedContext, country: 'USA' });
  expect(home.photos[0]?.detections[0]?.processed_classification).toEqual({
    class: deer,
    score: 0.9,
    source: 'classifier',
  });
});

test('a country change keeps the label of a detection with fewer than five raw classes', () => {
  const batch = importedBatch(speciesNetFile([deer, fox], [0.9, 0.05]));

  expect(hasCountryFixedLabels(batch)).toBe(true);
  expect(applyCountry(batch, { ...fixedContext, country: 'GBR' })).toEqual(batch);
});

test('every MegaDetector-format file keeps its labels on a country change', () => {
  const batch = importedBatch({
    info: { format_version: '1.6' },
    detection_categories: { '1': 'animal' },
    classification_categories: { [deer]: deer },
    images: [
      {
        file: 'a.jpg',
        detections: [
          {
            category: '1',
            conf: 0.9,
            bbox: [0, 0, 1, 1],
            classifications: [
              [deer, 0.9],
              [deer, 0.02],
              [deer, 0.02],
              [deer, 0.02],
              [deer, 0.02],
            ],
          },
        ],
      },
    ],
  });

  expect(hasCountryFixedLabels(batch)).toBe(true);
  expect(applyCountry(batch, { ...fixedContext, country: 'GBR' })).toEqual(batch);
});

test('the import error names the first bad field', () => {
  expect(importErrorMessage('predictions[0].detections[0].bbox')).toBe(
    'This file could not be imported: "predictions[0].detections[0].bbox" is missing or has the wrong type.',
  );
  expect(importErrorMessage('root')).toContain('not valid JSON');
  expect(COUNTRY_FIXED_NOTE).toBe('Country fixed by the imported file');
});
