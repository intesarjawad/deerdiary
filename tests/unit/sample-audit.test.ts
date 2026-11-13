import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, test } from 'vitest';
import { combine } from '../../src/core/ensemble';
import { burstCounter } from '../../src/core/events';
import { parseSpeciesNet } from '../../src/core/speciesnetJson';
import { loadTaxonomy } from '../../src/core/taxonomy';
import { diarySpecies } from '../../src/ui/Diary';
import { joinerVisits, sessionEvents, sheetTallies } from '../../src/ui/joinerVisits';
import { parseProvenance, scoreSample } from '../../tools/sample/score_sample';
import assets from '../golden/ensemble_assets.json';

const text = readFileSync('public/sample/predictions.json', 'utf8');
const parsed = parseSpeciesNet(JSON.parse(text));
if (!parsed.ok) throw new Error(`Invalid sample ${parsed.field}`);
const predictions = parsed.value.predictions;
const events = sessionEvents(text);
if (!events) throw new Error('Sample session is unreadable');
const score = scoreSample(
  predictions,
  parseProvenance(readFileSync('public/sample/PROVENANCE.txt', 'utf8')),
);
const taxonomyMap = loadTaxonomy(
  gunzipSync(Buffer.from(assets.taxonomyGzip, 'base64')).toString('utf8'),
);

test('the sample labels replay from raw model output without a geofence or label overrides', () => {
  let checked = 0;
  for (const image of predictions) {
    expect(image.country).toBeUndefined();
    for (const detection of image.detections) {
      const raw = detection.raw_classifications;
      if (!raw) continue;
      expect(combine(detection, raw, { taxonomyMap, geofenceMap: {} })).toEqual(
        detection.processed_classification,
      );
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(0);
});

test('sample scoring exposes misidentifications, broad labels and detector false positives', () => {
  expect(Object.fromEntries(score.confusion.get('raccoon') ?? [])).toEqual({
    'northern raccoon': 5,
    coyote: 1,
  });
  expect(Object.fromEntries(score.confusion.get('rodent') ?? [])).toEqual({ mammal: 3 });
  expect(score.emptyWithCard).toHaveLength(3);
  expect(sheetTallies(joinerVisits(events, diarySpecies(events)))).toEqual({
    named: 8,
    broader: 5,
    empty: 3,
  });
});

test('disjoint model false positives remain visible rather than being merged as one animal', () => {
  expect(score.cards.find(({ name }) => name === 'coyote')?.maxN).toBe(2);
  expect(score.cards.find(({ name }) => name === 'Unidentified animal')).toMatchObject({
    detections: 1,
    photoCount: 3,
    maxN: 2,
  });
});

test('the sample body, tail and lower-half boxes count once in every frame and card', () => {
  for (const prefix of ['59adfc81', '59b615dd', '59b61775']) {
    const event = events.find(({ photos }) => photos.some(({ path }) => path.includes(prefix)));
    const photo = event?.photos.find(({ path }) => path.includes(prefix));
    if (!event || !photo) throw new Error(`Missing sample frame ${prefix}`);
    const counted = burstCounter(event.photos);
    expect(photo.detections.filter((detection) => counted(detection) !== undefined)).toHaveLength(
      1,
    );
  }
  for (const name of ['mammal', 'striped skunk']) {
    expect(score.cards.find((card) => card.name === name)?.maxN).toBe(1);
  }
});
