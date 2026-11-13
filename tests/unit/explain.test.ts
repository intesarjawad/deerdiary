import { expect, test } from 'vitest';
import { type ExplainContext, explainSource, isPredictionSource } from '../../src/core/explain';
import { Classification, type PredictionSource } from '../../src/core/labels';
import {
  aroundBox,
  countedAsSentence,
  listedClasses,
  scoreText,
  topClasses,
  whyLabelSentences,
} from '../../src/ui/WhyLabel';

const BLACK_BEAR =
  '436ddfdd-bc43-44c3-a25d-34671d3430a0;mammalia;carnivora;ursidae;ursus;americanus;american black bear';
const WHITE_TAILED_DEER =
  '5c7ce479-8a45-40b3-ae21-7c97dfae22f5;mammalia;artiodactyla;cervidae;odocoileus;virginianus;white-tailed deer';
const MULE_DEER =
  'febff896-db40-4ac8-bcfe-5bb99a600950;mammalia;artiodactyla;cervidae;odocoileus;hemionus;mule deer';
const RED_DEER =
  'eb3829b0-772e-4088-ae90-f11b9fe38284;mammalia;artiodactyla;cervidae;cervus;elaphus;red deer';
const BROWN_BEAR =
  '330bb1e9-84d6-4e41-afa9-938aee17ea29;mammalia;carnivora;ursidae;ursus;arctos;brown bear';

const CONTEXT: ExplainContext = {
  classification: {
    classes: [BLACK_BEAR, WHITE_TAILED_DEER, MULE_DEER, RED_DEER, BROWN_BEAR],
    scores: [0.9901, 0.0038, 0.0035, 0.0007, 0.0005],
  },
  detector: { label: 'animal', conf: 0.9412 },
  country: 'GBR',
};

const DETECTOR_SENTENCE = 'The detector reported animal with 94% confidence.';
const CLASSIFIER_SENTENCE =
  "The classifier's top guess was american black bear with 99% confidence.";

const SOURCES = [
  'classifier',
  'detector',
  'classifier+rollup_to_species',
  'classifier+rollup_to_genus',
  'classifier+rollup_to_family',
  'classifier+rollup_to_order',
  'classifier+rollup_to_class',
  'classifier+rollup_to_kingdom',
  'classifier+geofence+rollup_to_species',
  'classifier+geofence+rollup_to_genus',
  'classifier+geofence+rollup_to_family',
  'classifier+geofence+rollup_to_order',
  'classifier+geofence+rollup_to_class',
  'classifier+geofence+rollup_to_kingdom',
  'classifier+geofence+rollup_failed',
] as const satisfies readonly PredictionSource[];

// A new source must be added to the list and the switch below, or the build fails.
type UncoveredSource = Exclude<PredictionSource, (typeof SOURCES)[number]>;
const COVERS_EVERY_SOURCE: [UncoveredSource] extends [never] ? true : never = true;

function expectedRule(source: PredictionSource): string {
  switch (source) {
    case 'classifier':
      return 'The top class cleared the animal threshold, so it stands as the label.';
    case 'detector':
      return "The detector's confidence was high enough, so its own label stands.";
    case 'classifier+rollup_to_species':
      return 'No class cleared the animal threshold on its own, so the top five were summed at species.';
    case 'classifier+rollup_to_genus':
      return 'No class cleared the animal threshold on its own, so the top five were summed at genus.';
    case 'classifier+rollup_to_family':
      return 'No class cleared the animal threshold on its own, so the top five were summed at family.';
    case 'classifier+rollup_to_order':
      return 'No class cleared the animal threshold on its own, so the top five were summed at order.';
    case 'classifier+rollup_to_class':
      return 'No class cleared the animal threshold on its own, so the top five were summed at class.';
    case 'classifier+rollup_to_kingdom':
      return 'No class cleared the animal threshold on its own, so the top five were summed at kingdom.';
    case 'classifier+geofence+rollup_to_species':
      return 'The GBR geofence blocks american black bear, so the top five were summed at species instead.';
    case 'classifier+geofence+rollup_to_genus':
      return 'The GBR geofence blocks american black bear, so the top five were summed at genus instead.';
    case 'classifier+geofence+rollup_to_family':
      return 'The GBR geofence blocks american black bear, so the top five were summed at family instead.';
    case 'classifier+geofence+rollup_to_order':
      return 'The GBR geofence blocks american black bear, so the top five were summed at order instead.';
    case 'classifier+geofence+rollup_to_class':
      return 'The GBR geofence blocks american black bear, so the top five were summed at class instead.';
    case 'classifier+geofence+rollup_to_kingdom':
      return 'The GBR geofence blocks american black bear, so the top five were summed at kingdom instead.';
    case 'classifier+geofence+rollup_failed':
      return 'The GBR geofence blocks american black bear and no broader group cleared the threshold, so the label is unknown.';
  }
  const unreachable: never = source;
  throw new Error(`Unexpected prediction source ${unreachable}`);
}

test('lists every prediction source', () => {
  expect(COVERS_EVERY_SOURCE).toBe(true);
});

test.each(SOURCES)('explains %s', (source) => {
  expect(explainSource(source, CONTEXT)).toEqual([
    DETECTOR_SENTENCE,
    CLASSIFIER_SENTENCE,
    expectedRule(source),
  ]);
});

test('names the geofence without a country', () => {
  expect(
    explainSource('classifier+geofence+rollup_to_order', { ...CONTEXT, country: undefined })[2],
  ).toBe('The geofence blocks american black bear, so the top five were summed at order instead.');
});

test.each([
  [Classification.BLANK, 'blank'],
  [Classification.HUMAN, 'human'],
  [Classification.VEHICLE, 'vehicle'],
  [Classification.UNKNOWN, 'unknown'],
])('names the generic class %s as %s', (label, name) => {
  const context: ExplainContext = {
    ...CONTEXT,
    classification: { classes: [label], scores: [0.5] },
  };
  expect(explainSource('classifier', context)[1]).toBe(
    `The classifier's top guess was ${name} with 50% confidence.`,
  );
});

const BEAR_DETECTION = {
  category: '1',
  label: 'animal',
  conf: 0.9412,
  bbox: [0.1, 0.2, 0.3, 0.4] as const,
  raw_classifications: CONTEXT.classification,
  processed_classification: {
    class: BLACK_BEAR,
    score: 0.9901,
    source: 'classifier+geofence+rollup_to_order' as const,
  },
};

test.each(SOURCES)('recognises the stored source %s', (source) => {
  expect(isPredictionSource(source)).toBe(true);
});

test('does not treat an unknown source as an ensemble rule', () => {
  expect(isPredictionSource('classifier+geofence')).toBe(false);
});

test('reads the top five in the order the classifier stored them', () => {
  expect(topClasses(BEAR_DETECTION).map(([label]) => label)).toEqual([
    BLACK_BEAR,
    WHITE_TAILED_DEER,
    MULE_DEER,
    RED_DEER,
    BROWN_BEAR,
  ]);
  expect(topClasses(BEAR_DETECTION).map(([, score]) => scoreText(score))).toEqual([
    '99%',
    '0.4%',
    '0.4%',
    '0.1%',
    '0.1%',
  ]);
});

test('builds the popover sentences from the stored detection', () => {
  expect(whyLabelSentences(BEAR_DETECTION, 'GBR')).toEqual([
    DETECTOR_SENTENCE,
    CLASSIFIER_SENTENCE,
    'The GBR geofence blocks american black bear, so the top five were summed at order instead.',
  ]);
});

test('leaves the popover unexplained for a source this build does not know', () => {
  expect(
    whyLabelSentences(
      {
        ...BEAR_DETECTION,
        processed_classification: { ...BEAR_DETECTION.processed_classification, source: 'other' },
      },
      'GBR',
    ),
  ).toEqual([]);
});

test('names the species a burst counted a broader box with', () => {
  expect(countedAsSentence('id;mammalia;lagomorpha;leporidae;lepus;americanus;snowshoe hare')).toBe(
    'The diary counted it with snowshoe hare because the same burst identified it.',
  );
});

test('lists only labels scored at one percent or more and counts the rest', () => {
  const { listed, hidden } = listedClasses(topClasses(BEAR_DETECTION));
  expect(listed.map(([label]) => label)).toEqual([BLACK_BEAR]);
  expect(hidden).toBe(4);
});

test('a thumbnail window is twice the box around its centre and stays inside the frame', () => {
  expect(aroundBox([0.4, 0.4, 0.1, 0.15])).toEqual([0.3, 0.325, 0.3].map((v) => expect.closeTo(v)));
  // A box at the edge is not centred past the frame.
  expect(aroundBox([0.9, 0.85, 0.1, 0.15])[0]).toBeCloseTo(0.7);
  // A tiny box still shows a fifth of the frame, not a few blown-up pixels.
  expect(aroundBox([0.5, 0.5, 0.01, 0.01])[2]).toBeCloseTo(0.2);
});
