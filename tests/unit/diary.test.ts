import { expect, test } from 'vitest';
import type { ClockStatus } from '../../src/core/time';
import type { DeerdiaryEvent, PhotoResult } from '../../src/core/types';
import { diaryPhotoCounts, diarySpecies } from '../../src/ui/Diary';

const deer = 'id;mammalia;artiodactyla;cervidae;odocoileus;virginianus;white-tailed deer';
const fox = 'id;mammalia;carnivora;canidae;vulpes;vulpes;red fox';

function photo(
  path: string,
  hour: number,
  labels: readonly string[],
  clockStatus: ClockStatus = 'ok',
  conf = 0.9,
): PhotoResult {
  return {
    path,
    time: {
      wallClockMs: Date.UTC(2026, 0, 1, hour),
      wallClockHour: hour,
      timeSource: 'exif',
      offsetTimeOriginal: null,
      clockStatus,
    },
    // Boxes sit side by side, so each is a separate animal.
    detections: labels.map((label, index) => ({
      category: '1',
      conf,
      bbox: [index * 0.2, 0.2, 0.15, 0.4],
      processed_classification: { class: label, score: 1, source: 'classifier' },
    })),
  };
}

function event(cameraKey: string, photos: readonly PhotoResult[]): DeerdiaryEvent {
  const best = new Map<string, PhotoResult>();
  for (const current of photos) {
    for (const detection of current.detections) {
      const label = detection.processed_classification?.class;
      if (label !== undefined) best.set(label, current);
    }
  }
  return {
    cameraKey,
    photos,
    species: Array.from(best, ([label, bestPhoto]) => ({ label, bestPhoto })),
  };
}

test('one card per species, ranked by independent detections', () => {
  const events = [
    event('cam', [photo('cam/a.jpg', 2, [deer, deer])]),
    event('cam', [photo('cam/b.jpg', 5, [deer])]),
    event('other', [photo('other/c.jpg', 2, [fox])]),
  ];

  const cards = diarySpecies(events);

  expect(cards).toHaveLength(2);
  expect(cards.map((card) => card.name)).toEqual(['white-tailed deer', 'red fox']);
  const deerCard = cards[0];
  expect(deerCard).toMatchObject({
    key: deer,
    scientificName: 'Odocoileus virginianus',
    species: true,
    detections: 2,
    photoCount: 2,
    maxN: 2,
    firstSeen: Date.UTC(2026, 0, 1, 2),
    lastSeen: Date.UTC(2026, 0, 1, 5),
    clockSuspect: false,
    firstSighting: false,
  });
  expect(deerCard?.labels).toEqual([deer]);
  expect(deerCard?.events).toHaveLength(2);
  expect(cards[1]?.scientificName).toBe('Vulpes vulpes');
});

const unknown =
  'f2efdae9-efb8-48fb-8a91-eccf79ab4ffb;no cv result;no cv result;no cv result;no cv result;no cv result;no cv result';

test('detector animal fallbacks share one unidentified card', () => {
  const events = [
    event('cam', [photo('cam/a.jpg', 2, ['animal']), photo('cam/b.jpg', 3, ['other;;;;;;animal'])]),
  ];

  const cards = diarySpecies(events);

  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({
    key: 'unidentified-animal',
    name: 'Unidentified animal',
    scientificName: null,
    detections: 1,
    photoCount: 2,
  });
});

test('an empty frame whose boxes the ensemble left unknown or blank makes no card', () => {
  const frame = photo('cam/empty.jpg', 8, [unknown, unknown], 'ok', 0.34);
  const events = [event('cam', [frame, photo('cam/empty-2.jpg', 8, ['blank'], 'ok', 0.33)])];

  expect(diarySpecies(events)).toEqual([]);
});

test('boxes below the counting confidence add no card, photo or detection', () => {
  const canis = 'id;mammalia;carnivora;canidae;canis;;canis species';
  const dog = 'id;mammalia;carnivora;canidae;canis;familiaris;domestic dog';
  const frame = photo('cam/a.jpg', 10, [dog], 'ok', 0.83);
  const faint = photo('cam/b.jpg', 10, [canis], 'ok', 0.11);

  const cards = diarySpecies([event('cam', [frame, faint])]);

  expect(cards.map((card) => card.name)).toEqual(['domestic dog']);
  expect(cards[0]).toMatchObject({ detections: 1, photoCount: 1, maxN: 1 });
});

test('a photo is blank only when nothing in it was counted', () => {
  const events = [
    event('cam', [
      photo('cam/a.jpg', 2, [deer, 'blank']),
      photo('cam/b.jpg', 3, ['blank', 'blank']),
      photo('cam/c.jpg', 3, [unknown]),
      photo('cam/d.jpg', 3, []),
      photo('cam/e.jpg', 3, [deer], 'ok', 0.15),
    ]),
    event('other', [photo('other/f.jpg', 4, ['human', 'vehicle'])]),
  ];

  expect(diarySpecies(events).map((card) => card.name)).toEqual(['white-tailed deer']);
  expect(diaryPhotoCounts(events)).toEqual({
    photoCount: 6,
    blankPhotos: 4,
    humanPhotos: 1,
    vehiclePhotos: 1,
  });
});

test('first sightings apply to identified species only', () => {
  const deerCards = diarySpecies([event('cam', [photo('cam/a.jpg', 8, [deer])])], {
    firstSightings: [deer],
  });
  const unidentifiedCards = diarySpecies([event('cam', [photo('cam/a.jpg', 8, ['animal'])])], {
    firstSightings: ['animal'],
  });

  expect(deerCards[0]?.firstSighting).toBe(true);
  expect(unidentifiedCards[0]?.firstSighting).toBe(false);
});

test('a suspect camera clock is reported and left out of the seen range', () => {
  const cards = diarySpecies([event('cam', [photo('cam/a.jpg', 8, [deer], 'suspect')])]);

  expect(cards[0]).toMatchObject({
    clockSuspect: true,
    firstSeen: null,
    lastSeen: null,
  });
});

test('a burst counts its broad label with the one species it identified', () => {
  const animal = '1f689929-883d-4dae-958c-3d57ab5b6c16;;;;;;animal';
  const opossum = 'id;mammalia;didelphimorphia;didelphidae;didelphis;virginiana;virginia opossum';
  const events = [
    event('cam', [
      photo('cam/a.jpg', 22, [opossum]),
      photo('cam/b.jpg', 22, [animal, animal], 'ok', 0.51),
    ]),
    event('cam', [photo('cam/c.jpg', 23, [animal], 'ok', 0.6)]),
  ];

  const cards = diarySpecies(events);

  expect(
    cards.map(({ name, detections, photoCount, maxN }) => [name, detections, photoCount, maxN]),
  ).toEqual([
    ['Unidentified animal', 1, 1, 1],
    ['virginia opossum', 1, 2, 2],
  ]);
});
