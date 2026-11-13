import { expect, test } from 'vitest';
import { buildCsvRows, correctionKey, eventId } from '../../src/app/export';
import { correctedEvents } from '../../src/core/corrections';
import { groupEvents } from '../../src/core/events';
import { independentDetections } from '../../src/core/independence';
import { Classification } from '../../src/core/labels';
import { rankForReel, reelEndCard } from '../../src/core/reel';
import type { CameraTime } from '../../src/core/time';
import type { PhotoResult } from '../../src/core/types';
import type { StoredResult } from '../../src/storage/schema';
import {
  CORRECTION_MATCH_LIMIT,
  correctionEntries,
  filterLabels,
  labelNames,
} from '../../src/ui/Corrections';
import { diaryPhotoCounts, diarySpecies } from '../../src/ui/Diary';
import type { ClassifiedDetection } from '../../src/workers/photo';

const deer = 'deer-id;mammalia;artiodactyla;cervidae;odocoileus;virginianus;white-tailed deer';
const fox = 'fox-id;mammalia;carnivora;canidae;vulpes;vulpes;red fox';
const start = Date.UTC(2026, 0, 1, 6);

const time: CameraTime = {
  wallClockMs: start,
  wallClockHour: 6,
  timeSource: 'exif',
  offsetTimeOriginal: null,
  clockStatus: 'ok',
};

function detection(label: string, index: number): ClassifiedDetection {
  return {
    category: '1',
    label: 'animal',
    conf: 0.9,
    bbox: [index * 0.1, 0, 0.2, 0.2],
    processed_classification: { class: label, score: 0.9, source: 'classifier' },
  };
}

function fixture() {
  const detections = [detection(deer, 0), detection(fox, 1)];
  const photo: PhotoResult = { path: 'card/DCIM/a.jpg', time, detections };
  const events = groupEvents([photo]);
  const stored: StoredResult = {
    key: 'card/DCIM/a.jpg|1|2',
    time,
    output: {
      path: photo.path,
      backend: 'wasm',
      ms: { decode: 0, preprocess: 0, detect: 0, classify: 0, ensemble: 0, thumbnail: 0, total: 0 },
      status: 'ok',
      width: 100,
      height: 80,
      thumbnail: new Blob(['preview']),
      detections,
    },
  };
  const event = events[0];
  if (!event) throw new Error('Expected one grouped event');
  return { event, events, stored };
}

test('reads common and scientific names from a classifier label', () => {
  expect(labelNames(deer)).toEqual({
    commonName: 'White-tailed deer',
    scientificName: 'Odocoileus virginianus',
  });
  expect(labelNames('animal')).toEqual({ commonName: 'Unidentified animal', scientificName: null });
});

test('filters by either name and renders no more than fifty matches', () => {
  const labels = [
    deer,
    fox,
    'hare-id;mammalia;lagomorpha;leporidae;lepus;europaeus;european hare',
    'mouse-id;mammalia;rodentia;muridae;mus;musculus;house mouse',
  ];

  expect(filterLabels(labels, 'virginianus')).toEqual([deer]);
  expect(filterLabels(labels, 'FOX')).toEqual([fox]);
  expect(filterLabels(labels, 'mus')).toEqual([
    'mouse-id;mammalia;rodentia;muridae;mus;musculus;house mouse',
  ]);
  expect(filterLabels(labels, '')).toEqual(labels);
  expect(
    filterLabels(
      Array.from({ length: 60 }, (_, index) => `id-${index};;;;;;species ${index}`),
      '',
    ).length,
  ).toBe(CORRECTION_MATCH_LIMIT);
  expect(filterLabels(labels, 'e', 0)).toEqual([]);
  expect(filterLabels(labels, 'nothing')).toEqual([]);
});

test('one mixed-species event produces one correction entry per species', () => {
  const { event } = fixture();
  const entries = correctionEntries([event]);
  const id = eventId(event);

  expect(entries).toEqual([
    {
      key: correctionKey(id, deer),
      eventId: id,
      label: deer,
      commonName: 'White-tailed deer',
      scientificName: 'Odocoileus virginianus',
    },
    {
      key: correctionKey(id, fox),
      eventId: id,
      label: fox,
      commonName: 'Red fox',
      scientificName: 'Vulpes vulpes',
    },
  ]);
});

test('correcting one species leaves the other CSV row unchanged', () => {
  const { event, events, stored } = fixture();
  const id = eventId(event);
  const muleDeer = 'mule-id;mammalia;artiodactyla;cervidae;odocoileus;hemionus;mule deer';
  const corrections = { [correctionKey(id, deer)]: muleDeer };

  const rows = buildCsvRows({ results: [stored], events, corrections });

  expect(rows.map((row) => row.common_name)).toEqual(['mule deer', 'red fox']);
  expect(rows.map((row) => row.corrected_common_name)).toEqual(['mule deer', null]);
});

test('one corrected view feeds diary cards, the clock and the reel without changing originals', () => {
  const { event, events } = fixture();
  const corrected = correctedEvents(events, { [correctionKey(eventId(event), deer)]: fox });
  expect(diarySpecies(corrected).map((card) => card.key)).toEqual([fox]);
  expect(independentDetections(corrected, 30).map((entry) => entry.label)).toEqual([fox]);
  expect(rankForReel(corrected).map((shot) => shot.label)).toEqual([fox]);
  expect(reelEndCard(corrected, { name: 'Deerdiary' }).species).toEqual([
    { label: fox, name: 'red fox', detections: 1 },
  ]);
  expect(events[0]?.species.map((species) => species.label)).toEqual([deer, fox]);
});

test('correcting an animal to human removes its clock sighting and updates photo totals', () => {
  const { event, events } = fixture();
  const corrected = correctedEvents(events, {
    [correctionKey(eventId(event), deer)]: Classification.HUMAN,
  });
  expect(independentDetections(corrected, 30).map((entry) => entry.label)).toEqual([fox]);
  expect(diaryPhotoCounts(corrected).humanPhotos).toBe(1);
});

test('CSV marks broad boxes folded into a corrected species as corrected too', () => {
  const { stored } = fixture();
  if (stored.output.status !== 'ok') throw new Error('Expected a classified photo');
  const first = stored.output.detections[0];
  if (!first) throw new Error('Expected a detection');
  const detections = [
    {
      ...first,
      processed_classification: { class: Classification.ANIMAL, score: 0.8, source: 'detector' },
    },
    first,
  ];
  const events = groupEvents([{ path: stored.output.path, time: stored.time, detections }]);
  const current = events[0];
  if (!current) throw new Error('Expected an event');
  const rows = buildCsvRows({
    results: [{ ...stored, output: { ...stored.output, detections } }],
    events,
    corrections: { [correctionKey(eventId(current), deer)]: fox },
  });
  expect(rows.map((row) => row.corrected_common_name)).toEqual(['red fox', 'red fox']);
});
