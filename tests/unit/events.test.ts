import { expect, test } from 'vitest';
import {
  burstCounter,
  burstFolds,
  cameraKey,
  groupEvents,
  maxN,
  sightingLabel,
} from '../../src/core/events';
import { independentDetections } from '../../src/core/independence';
import type { Detection, PhotoResult } from '../../src/core/types';

const deer = 'id;mammalia;artiodactyla;cervidae;odocoileus;virginianus;white-tailed deer';
const fox = 'id;mammalia;carnivora;canidae;vulpes;vulpes;red fox';
const baseMs = Date.UTC(2026, 2, 8, 2, 30);

function box(label = deer, conf = 0.9, score = 0.8, area = 0.25, left = 0): Detection {
  return {
    category: '1',
    conf,
    bbox: [left, 0, area, 1],
    processed_classification: { class: label, score, source: 'classifier' },
  };
}

function photo(path: string, seconds: number, detections = [box()]): PhotoResult {
  return {
    path,
    detections,
    time: {
      wallClockMs: baseMs + seconds * 1000,
      wallClockHour: 2,
      timeSource: 'exif',
      offsetTimeOriginal: null,
      clockStatus: 'ok',
    },
  };
}

test.each([
  ['cam1/DCIM/100MEDIA/a.jpg', 'cam1/DCIM'],
  ['cam1/DCIM/101MEDIA/b.jpg', 'cam1/DCIM'],
  ['cam2/DCIM/100MEDIA/a.jpg', 'cam2/DCIM'],
  ['DCIM/100MEDIA/a.jpg', 'DCIM'],
  ['100MEDIA/a.jpg', ''],
  ['garden/a.jpg', 'garden'],
  ['garden/100media/a.jpg', 'garden/100media'],
  ['garden/100MEDI/a.jpg', 'garden/100MEDI'],
  ['a.jpg', ''],
])('camera key for %s is %s', (path, expected) => {
  expect(cameraKey(path)).toBe(expected);
});

test.each([
  [59, 1],
  [60, 2],
  [61, 2],
])('a %i second gap yields %i events', (gap, count) => {
  const photos = [photo('garden/b.jpg', gap), photo('garden/a.jpg', 0)];
  expect(groupEvents(photos)).toHaveLength(count);
  expect(photos[0]?.path).toBe('garden/b.jpg');
});

test('groups adjacent gaps, sorts frames and keeps cameras separate', () => {
  const events = groupEvents([
    photo('garden/c.jpg', 118),
    photo('orchard/a.jpg', 0),
    photo('garden/b.jpg', 59),
    photo('garden/a.jpg', 0),
  ]);
  expect(events).toHaveLength(2);
  expect(events.find((event) => event.cameraKey === 'garden')?.photos.map((p) => p.path)).toEqual([
    'garden/a.jpg',
    'garden/b.jpg',
    'garden/c.jpg',
  ]);
  expect(groupEvents([])).toEqual([]);
  expect(groupEvents([photo('a.jpg', 0), photo('b.jpg', 59)], 30_000)).toHaveLength(2);
});

test('DCF rollover preserves bursts and independence without merging other cameras', () => {
  const events = groupEvents([
    photo('cam1/DCIM/100MEDIA/a.jpg', 0),
    photo('cam1/DCIM/101MEDIA/b.jpg', 59),
    photo('cam1/DCIM/101MEDIA/c.jpg', 29 * 60),
    photo('cam1/DCIM/102MEDIA/d.jpg', 31 * 60),
    photo('cam2/DCIM/100MEDIA/a.jpg', 0),
  ]);
  expect(events).toHaveLength(4);
  expect(events.find((event) => event.cameraKey === 'cam1/DCIM')?.photos).toHaveLength(2);
  const detections = independentDetections(events, 30);
  expect(
    detections
      .filter((detection) => detection.cameraKey === 'cam1/DCIM')
      .map((detection) => detection.time.wallClockMs),
  ).toEqual([baseMs, baseMs + 31 * 60_000]);
  expect(detections.filter((detection) => detection.cameraKey === 'cam2/DCIM')).toHaveLength(1);
});

test('independence is strict and measured from the previous counted event per species', () => {
  const events = groupEvents([
    photo('a/1.jpg', 0),
    photo('a/2.jpg', 29 * 60, [box(), box(fox)]),
    photo('a/3.jpg', 30 * 60),
    photo('a/4.jpg', 31 * 60),
  ]);
  const detections = independentDetections(events.toReversed(), 30);
  expect(detections.filter((detection) => detection.label === deer)).toHaveLength(2);
  expect(detections.filter((detection) => detection.label === fox)).toHaveLength(1);
  expect(independentDetections(events, 1).filter((d) => d.label === deer)).toHaveLength(3);
  expect(independentDetections([], 30)).toEqual([]);
});

test('keeps every processed animal label and chooses each best photo by conf * score * a portrait-sized area', () => {
  const first = photo('a/1.jpg', 0, [box(deer, 0.9, 0.9, 0.1), box(fox)]);
  const second = photo('a/2.jpg', 1, [box(deer, 0.8, 0.8, 0.3), box(fox, 0.5)]);
  const [event] = groupEvents([second, first]);
  expect(event?.species).toEqual([
    { label: deer, bestPhoto: second },
    { label: fox, bestPhoto: first },
  ]);
});

test('dates a species detection from its first matching frame, retaining clock status', () => {
  const first = photo('a/1.jpg', 0);
  const second = photo('a/2.jpg', 59, [box(fox)]);
  const detections = independentDetections(groupEvents([second, first]), 30);
  expect(detections.find((detection) => detection.label === fox)?.time).toEqual(second.time);
  expect(detections.find((detection) => detection.label === deer)?.time).toEqual(first.time);
});

test('ignores unclassified boxes and processed blank, human, vehicle and unknown labels', () => {
  const [event] = groupEvents([
    photo('a.jpg', 0, [
      { category: '1', conf: 0.9, bbox: [0, 0, 1, 1] },
      box('id;;;;;;blank'),
      box('id;mammalia;primates;hominidae;homo;sapiens;human'),
      box('id;;;;;;vehicle'),
      box('id;;;;;;animal'),
      box('id;no cv result;no cv result;no cv result;no cv result;no cv result;no cv result'),
    ]),
  ]);
  expect(event?.species.map((species) => species.label)).toEqual(['id;;;;;;animal']);
});

test('a box below the counting confidence names no species and opens no detection', () => {
  const faint = photo('a.jpg', 0, [box(fox, 0.15)]);
  const later = photo('b.jpg', 20, [box(fox, 0.2)]);
  const [event] = groupEvents([faint, later]);

  expect(event?.species.map((species) => species.label)).toEqual([fox]);
  expect(sightingLabel(box(fox, 0.15))).toBeUndefined();
  expect(independentDetections(groupEvents([faint, later]), 30)[0]?.time).toEqual(later.time);
  expect(groupEvents([faint])[0]?.species).toEqual([]);
});

test('MaxN counts qualifying boxes within a single frame, never across the burst', () => {
  const [event] = groupEvents([
    photo('a/1.jpg', 0, [box(), box(deer, 0.9, 0.8, 0.25, 0.25), box(deer, 0.15), box(fox)]),
    photo('a/2.jpg', 1, [
      box(),
      box(deer, 0.2, 0.8, 0.25, 0.25),
      box(deer, 0.9, 0.8, 0.25, 0.5),
      box(deer, 0.15, 0.8, 0.25, 0.75),
    ]),
  ]);
  if (!event) throw new Error('Expected one event');
  expect(maxN(event, deer)).toBe(3);
  expect(maxN(event, fox)).toBe(1);
  expect(maxN(event, 'absent')).toBe(0);
});

const animal = '1f689929-883d-4dae-958c-3d57ab5b6c16;;;;;;animal';
const leporids = 'id;mammalia;lagomorpha;leporidae;;;rabbit and hare family';
const snowshoe = 'id;mammalia;lagomorpha;leporidae;lepus;americanus;snowshoe hare';
const mammal = 'id;mammalia;;;;;mammal';
const coyote = 'id;mammalia;carnivora;canidae;canis;latrans;coyote';
const dog = 'id;mammalia;carnivora;canidae;canis;familiaris;domestic dog';

function burst(...frames: Detection[][]) {
  const [event] = groupEvents(
    frames.map((detections, index) => photo(`b/${index}.jpg`, index, detections)),
  );
  if (!event) throw new Error('Expected one burst');
  return event;
}

function speciesLabels(event: ReturnType<typeof burst>): string[] {
  return event.species.map(({ label }) => label);
}

test('a family label folds into the one species of its family in the same burst', () => {
  const event = burst([box(leporids)], [box(snowshoe)], [box(leporids)]);

  expect(burstFolds(event.photos)).toEqual(new Map([[leporids, snowshoe]]));
  expect(speciesLabels(event)).toEqual([snowshoe]);
  expect(event.photos[0]?.detections[0]?.processed_classification?.class).toBe(leporids);
  expect(burstCounter(event.photos)(box(leporids))).toBe(snowshoe);
});

test('the animal fallback and a chain of broader labels fold into the one species', () => {
  const event = burst([box(coyote)], [box(animal, 0.58)], [box(mammal)]);

  expect(burstFolds(event.photos)).toEqual(
    new Map([
      [animal, coyote],
      [mammal, coyote],
    ]),
  );
  expect(speciesLabels(event)).toEqual([coyote]);
});

test('a broad label that could be either of two species keeps its own count', () => {
  const event = burst([box(coyote)], [box(animal)], [box(fox)]);

  expect(burstFolds(event.photos)).toEqual(new Map());
  expect(speciesLabels(event).toSorted()).toEqual([animal, coyote, fox].toSorted());
});

test('siblings never fold into each other', () => {
  expect(burstFolds(burst([box(coyote)], [box(dog)]).photos)).toEqual(new Map());
});

test('labels never fold across bursts', () => {
  const events = groupEvents([
    photo('b/1.jpg', 0, [box(coyote)]),
    photo('b/2.jpg', 120, [box(animal)]),
  ]);

  expect(events.map((event) => event.species.map(({ label }) => label))).toEqual([
    [coyote],
    [animal],
  ]);
});

test('a folded box keeps its stored label and counts toward MaxN in its frame', () => {
  const event = burst([box(coyote), box(animal, 0.9, 0.8, 0.25, 0.5)]);

  expect(maxN(event, coyote)).toBe(2);
  expect(maxN(event, animal)).toBe(0);
  expect(event.photos[0]?.detections[1]?.processed_classification?.class).toBe(animal);
});

const skunk = 'id;mammalia;carnivora;mephitidae;mephitis;mephitis;striped skunk';
const unknown = 'id;no cv result;no cv result;no cv result;no cv result;no cv result;no cv result';

function sampleBox(
  category: Detection['category'],
  conf: number,
  bbox: Detection['bbox'],
  label: string,
): Detection {
  return {
    category,
    conf,
    bbox,
    processed_classification: { class: label, score: 0.7, source: 'classifier' },
  };
}

test('boxes of parts of one animal inside its best box count once', () => {
  // The instant sample's rodent frame 59adfc81: the detector boxes the body, then body and tail.
  const body = sampleBox('1', 0.7243, [0.8758, 0.8092, 0.0855, 0.1028], mammal);
  const withTail = sampleBox('1', 0.3677, [0.874, 0.6881, 0.1091, 0.2291], mammal);
  const wider = sampleBox('1', 0.3165, [0.8749, 0.6618, 0.1224, 0.2543], mammal);
  const faint = sampleBox('1', 0.1712, [0.8779, 0.8159, 0.0475, 0.0842], mammal);
  const event = burst([body, withTail, wider, faint]);
  const counted = burstCounter(event.photos);

  expect(maxN(event, mammal)).toBe(1);
  expect([body, withTail, wider, faint].map(counted)).toEqual([
    mammal,
    undefined,
    undefined,
    undefined,
  ]);
  expect(event.photos[0]?.detections[1]?.processed_classification?.class).toBe(mammal);
});

test('a broad box inside a species box folds into it and counts once', () => {
  // The instant sample's skunk frame 59b61775: the classifier calls the lower half only a mammal.
  const whole = sampleBox('1', 0.8409, [0.3541, 0.3487, 0.0775, 0.1345], skunk);
  const lowerHalf = sampleBox('1', 0.2603, [0.3543, 0.4345, 0.0723, 0.0497], mammal);
  const event = burst([
    whole,
    sampleBox('2', 0.2605, [0.3541, 0.1794, 0.0779, 0.304], unknown),
    lowerHalf,
    sampleBox('1', 0.2391, [0.3718, 0.181, 0.0573, 0.1241], unknown),
  ]);

  expect(speciesLabels(event)).toEqual([skunk]);
  expect(maxN(event, skunk)).toBe(1);
  expect(burstCounter(event.photos)(lowerHalf)).toBeUndefined();
});

test('only a box almost wholly inside a box of the same label repeats that animal', () => {
  const left = box(deer, 0.9, 0.8, 0.4, 0);
  const halfOver = box(deer, 0.8, 0.8, 0.4, 0.2);
  expect(maxN(burst([left, halfOver]), deer)).toBe(2);

  const nestedDeer: Detection = { ...box(deer, 0.8), bbox: [0.1, 0.2, 0.1, 0.3] };
  expect(maxN(burst([left, nestedDeer]), deer)).toBe(1);

  const nestedFox: Detection = { ...box(fox, 0.8), bbox: [0.1, 0.2, 0.1, 0.3] };
  const mixed = burst([left, nestedFox]);
  expect([maxN(mixed, deer), maxN(mixed, fox)]).toEqual([1, 1]);
});

test('a faint broad box neither folds nor counts', () => {
  const event = burst([box(coyote)], [box(animal, 0.15)]);

  expect(burstFolds(event.photos)).toEqual(new Map());
  expect(maxN(event, coyote)).toBe(1);
});
