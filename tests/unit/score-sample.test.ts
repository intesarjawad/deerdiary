import { expect, test } from 'vitest';
import type { SpeciesNetDetection, SpeciesNetImage } from '../../src/core/speciesnetJson';
import { formatScore, parseProvenance, scoreSample } from '../../tools/sample/score_sample';

const fox = 'id;mammalia;carnivora;canidae;vulpes;vulpes;red fox';
const unknown =
  'f2efdae9-efb8-48fb-8a91-eccf79ab4ffb;no cv result;no cv result;no cv result;no cv result;no cv result;no cv result';
const sha = 'a'.repeat(64);

const provenance = [
  'Changes',
  'file  sequence  frame  captured  dataset label  original sha256',
  `e1.jpg  s1  1  2011-06-17 08:02:08  empty  ${sha}`,
  `e2.jpg  s2  1  2011-06-18 08:02:08  empty  ${sha}`,
  `f1.jpg  s3  1  2011-06-19 22:00:00  fox  ${sha}`,
  `f2.jpg  s3  2  2011-06-19 22:00:01  fox  ${sha}`,
  `c1.jpg  s4  1  2011-06-20 03:00:00  coyote  ${sha}`,
].join('\n');

function box(label: string, conf: number): SpeciesNetDetection {
  return {
    category: '1',
    label: 'animal',
    conf,
    bbox: [0, 0, 0.5, 0.5],
    processed_classification: { class: label, score: 0.9, source: 'classifier' },
  };
}

function image(name: string, detections: SpeciesNetDetection[]): SpeciesNetImage {
  return { filepath: `sample/${name}`, detections };
}

const predictions = [
  image('e1.jpg', [box(unknown, 0.4)]),
  image('e2.jpg', [box('id;;;;;;animal', 0.8)]),
  image('f1.jpg', [box(fox, 0.9)]),
  image('f2.jpg', [box(fox, 0.9)]),
  image('c1.jpg', [box(fox, 0.7)]),
];

test('reads labels and wall-clock capture times from the provenance table', () => {
  const sample = parseProvenance(provenance);

  expect(sample.size).toBe(5);
  expect(sample.get('f2.jpg')).toEqual({
    label: 'fox',
    wallClockMs: Date.UTC(2011, 5, 19, 22, 0, 1),
  });
});

test('scores empty frames, confusions and independent detections against the dataset', () => {
  const score = scoreSample(predictions, parseProvenance(provenance));

  expect(score).toMatchObject({ photoCount: 5, emptyCount: 2, emptyWithCard: ['e2.jpg'] });
  expect(Object.fromEntries(score.confusion.get('empty') ?? [])).toEqual({
    '(no card)': 1,
    'Unidentified animal': 1,
  });
  expect(Object.fromEntries(score.confusion.get('coyote') ?? [])).toEqual({ 'red fox': 1 });
  expect(score.cards.map(({ name, detections }) => [name, detections])).toEqual([
    ['red fox', 2],
    ['Unidentified animal', 1],
  ]);
  expect(score.cards[0]).toMatchObject({ photoCount: 3, maxN: 1 });
  expect(formatScore(score)).toContain('red fox                    2  photos 3, MaxN 1');
  expect(Object.fromEntries(score.cards[0]?.byLabel ?? [])).toEqual({ fox: 1, coyote: 1 });
  expect(Object.fromEntries(score.datasetDetections)).toEqual({ fox: 1, coyote: 1 });
  expect(formatScore(score)).toContain('Empty frames that add to a card: 1 of 2 (e2.jpg)');
});

test('a photo missing from the provenance table is an error', () => {
  expect(() => scoreSample([image('missing.jpg', [])], parseProvenance(provenance))).toThrowError(
    'sample/missing.jpg has no row in the provenance table.',
  );
});

test('scores a broad box with the species its burst identified', () => {
  const animal = '1f689929-883d-4dae-958c-3d57ab5b6c16;;;;;;animal';
  const score = scoreSample(
    [image('f1.jpg', [box(fox, 0.9)]), image('f2.jpg', [box(animal, 0.6)])],
    parseProvenance(provenance),
  );

  expect(Object.fromEntries(score.confusion.get('fox') ?? [])).toEqual({ 'red fox': 2 });
  expect(score.cards.map(({ name, detections }) => [name, detections])).toEqual([['red fox', 1]]);
});
