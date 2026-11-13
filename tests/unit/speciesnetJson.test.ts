import { expect, test } from 'vitest';
import {
  parseSpeciesNet,
  SPECIESNET_FORMAT_VERSION,
  toSpeciesNetJson,
} from '../../src/core/speciesnetJson';

const deer = 'deer-uuid;mammalia;artiodactyla;cervidae;odocoileus;virginianus;white-tailed deer';

const sixClasses = {
  classes: ['a', 'b', 'c', 'd', 'e', 'f'],
  scores: [0.5, 0.2, 0.1, 0.1, 0.05, 0.05],
};

function exportInput() {
  return {
    predictions: [
      {
        filepath: 'card/DCIM/100MEDIA/a.jpg',
        detections: [
          {
            category: '1',
            label: 'animal',
            conf: 0.9,
            bbox: [0.1, 0.2, 0.3, 0.4] as const,
            raw_classifications: sixClasses,
            processed_classification: {
              class: deer,
              score: 0.88,
              source: 'classifier' as const,
            },
          },
        ],
      },
    ],
    events: [
      {
        id: 'card/DCIM@1000',
        camera: 'card/DCIM',
        photos: ['card/DCIM/100MEDIA/a.jpg'],
        species: [deer],
      },
    ],
    corrections: { [deer]: 'Deer' },
    independenceIntervalMin: 30,
  };
}

test('writes the SpeciesNet version, the app block and only the top five raw classes', () => {
  const written = JSON.parse(toSpeciesNetJson(exportInput()));

  expect(written.info).toEqual({ format_version: SPECIESNET_FORMAT_VERSION });
  expect(written.predictions[0].filepath).toBe('card/DCIM/100MEDIA/a.jpg');
  expect(written.predictions[0].detections[0].raw_classifications).toEqual({
    classes: ['a', 'b', 'c', 'd', 'e'],
    scores: [0.5, 0.2, 0.1, 0.1, 0.05],
  });
  expect(written.deerdiary).toEqual({
    version: 1,
    events: [
      {
        id: 'card/DCIM@1000',
        camera: 'card/DCIM',
        photos: ['card/DCIM/100MEDIA/a.jpg'],
        species: [deer],
      },
    ],
    corrections: { [deer]: 'Deer' },
    independence_interval_min: 30,
  });
});

test('parses the written file back with its app block', () => {
  const parsed = parseSpeciesNet(JSON.parse(toSpeciesNetJson(exportInput())));

  expect(parsed).toEqual({
    ok: true,
    value: {
      formatVersion: SPECIESNET_FORMAT_VERSION,
      predictions: [
        {
          filepath: 'card/DCIM/100MEDIA/a.jpg',
          detections: [
            {
              category: '1',
              label: 'animal',
              conf: 0.9,
              bbox: [0.1, 0.2, 0.3, 0.4],
              raw_classifications: {
                classes: ['a', 'b', 'c', 'd', 'e'],
                scores: [0.5, 0.2, 0.1, 0.1, 0.05],
              },
              processed_classification: {
                class: deer,
                score: 0.88,
                source: 'classifier',
              },
            },
          ],
        },
      ],
      app: {
        version: 1,
        events: [
          {
            id: 'card/DCIM@1000',
            camera: 'card/DCIM',
            photos: ['card/DCIM/100MEDIA/a.jpg'],
            species: [deer],
          },
        ],
        corrections: { [deer]: 'Deer' },
        independenceIntervalMin: 30,
      },
    },
  });
});

test('accepts a plain SpeciesNet file without the app block', () => {
  const parsed = parseSpeciesNet({
    info: { format_version: SPECIESNET_FORMAT_VERSION },
    predictions: [{ filepath: 'a.jpg' }],
  });

  expect(parsed).toEqual({
    ok: true,
    value: {
      formatVersion: SPECIESNET_FORMAT_VERSION,
      predictions: [{ filepath: 'a.jpg', detections: [] }],
    },
  });
});

test('accepts the former block name so older exports still import', () => {
  const parsed = parseSpeciesNet({
    info: { format_version: SPECIESNET_FORMAT_VERSION },
    predictions: [],
    wild: {
      version: 1,
      events: [],
      corrections: {},
      independence_interval_min: 30,
    },
  });

  expect(parsed.ok && parsed.value.app?.independenceIntervalMin).toBe(30);
});

test('names the first bad detection field', () => {
  const parsed = parseSpeciesNet({
    info: { format_version: SPECIESNET_FORMAT_VERSION },
    predictions: [
      {
        filepath: 'a.jpg',
        detections: [{ category: '1', label: 'animal', conf: '0.9', bbox: [0, 0, 1, 1] }],
      },
    ],
  });

  expect(parsed).toEqual({
    ok: false,
    field: 'predictions[0].detections[0].conf',
  });
});

test('rejects raw classes and scores of different lengths', () => {
  const parsed = parseSpeciesNet({
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
            raw_classifications: { classes: ['a', 'b'], scores: [0.9] },
          },
        ],
      },
    ],
  });

  expect(parsed).toEqual({
    ok: false,
    field: 'predictions[0].detections[0].raw_classifications',
  });
});
