import { expect, test } from 'vitest';
import {
  REEL_CROSSFADE_MS,
  REEL_END_CARD_MS,
  REEL_FRAME_RATE,
  REEL_SCALE_DRIFT,
  REEL_SHOT_MS,
  rankForReel,
  reelDurationMs,
  reelEndCard,
  reelFrameCount,
  reelLayers,
} from '../../src/core/reel';
import type { ClockStatus } from '../../src/core/time';
import type { DeerdiaryEvent, PhotoResult } from '../../src/core/types';
import {
  REEL_END_CARD_STORAGE_KEY,
  readIncludeEndCard,
  reelExportRequest,
  storeIncludeEndCard,
} from '../../src/ui/Reel';

const deer = 'deer-id;mammalia;artiodactyla;cervidae;odocoileus;virginianus;white-tailed deer';
const fox = 'fox-id;mammalia;carnivora;canidae;vulpes;vulpes;red fox';
const badger = 'badger-id;mammalia;carnivora;mustelidae;meles;meles;eurasian badger';
const hare = 'hare-id;mammalia;lagomorpha;leporidae;lepus;europaeus;european hare';
const hour = 3_600_000;

function photo(
  path: string,
  wallClockMs: number,
  detections: readonly {
    label: string;
    conf?: number;
    size?: number;
    clockStatus?: ClockStatus;
  }[],
): PhotoResult {
  return {
    path,
    time: {
      wallClockMs,
      wallClockHour: new Date(wallClockMs).getUTCHours(),
      timeSource: 'exif',
      offsetTimeOriginal: null,
      clockStatus: detections[0]?.clockStatus ?? 'ok',
    },
    detections: detections.map(({ label, conf = 0.9, size = 0.5 }) => ({
      category: '1',
      conf,
      bbox: [0, 0, size, size],
      processed_classification: { class: label, score: 0.9, source: 'classifier' },
    })),
  };
}

function event(cameraKey: string, photos: readonly PhotoResult[]): DeerdiaryEvent {
  const best = new Map<string, PhotoResult>();
  for (const current of photos) {
    for (const detection of current.detections) {
      const label = detection.processed_classification?.class;
      if (label !== undefined && !best.has(label)) best.set(label, current);
    }
  }
  return {
    cameraKey,
    photos,
    species: Array.from(best, ([label, bestPhoto]) => ({ label, bestPhoto })),
  };
}

test('eight shots last 9.6 seconds and the optional card adds two seconds', () => {
  expect(REEL_SHOT_MS).toBe(1200);
  expect(REEL_END_CARD_MS).toBe(2000);
  expect(reelDurationMs(8, true)).toBe(11_600);
  expect(reelDurationMs(8, false)).toBe(9_600);
  expect(reelDurationMs(3, false)).toBe(3_600);
});

test('ranks one best shot per burst by independent detections and frame quality', () => {
  const start = Date.UTC(2026, 0, 1, 6);
  const lower = event('cam', [
    photo('cam/deer-1.jpg', start, [{ label: deer, conf: 0.8, size: 0.3 }]),
    photo('cam/deer-2.jpg', start, [{ label: deer, conf: 0.95, size: 0.6 }]),
  ]);
  const middle = event('cam', [
    photo('cam/deer-3.jpg', start + 2 * hour, [{ label: deer, conf: 0.9, size: 0.5 }]),
  ]);
  const high = event('cam', [
    photo('cam/deer-4.jpg', start + 4 * hour, [{ label: deer, conf: 0.99, size: 0.8 }]),
  ]);
  const other = event('cam', [
    photo('cam/fox.jpg', start + 6 * hour, [{ label: fox, conf: 1, size: 1 }]),
  ]);

  const ranked = rankForReel([lower, middle, high, other], 3);

  expect(ranked).toHaveLength(3);
  expect(ranked.map((shot) => shot.photo.path)).toEqual([
    'cam/deer-4.jpg',
    'cam/deer-2.jpg',
    'cam/deer-3.jpg',
  ]);
  expect(ranked.every((shot) => shot.label === deer)).toBe(true);
  expect(ranked[0]?.independent).toBe(3);
  expect(rankForReel([lower, middle, high, other], 0)).toEqual([]);
});

test('leaves out bursts holding only fallbacks or non-species labels', () => {
  const start = Date.UTC(2026, 0, 1, 6);
  const events = [
    event('cam', [photo('cam/blank.jpg', start, [{ label: 'blank-uuid;;;;;;blank' }])]),
    event('cam', [photo('cam/person.jpg', start + hour, [{ label: 'human-id;;;;;;human' }])]),
    event('cam', [photo('cam/animal.jpg', start + 2 * hour, [{ label: 'animal' }])]),
  ];

  expect(rankForReel(events)).toEqual([]);
});

test('the end card lists the three most independent species and the diary dates', () => {
  const start = Date.UTC(2026, 2, 1, 6);
  const events = [
    event('cam', [photo('cam/deer-1.jpg', start, [{ label: deer }])]),
    event('cam', [photo('cam/deer-2.jpg', start + hour, [{ label: deer }])]),
    event('cam', [photo('cam/deer-3.jpg', start + 2 * hour, [{ label: deer }])]),
    event('cam', [photo('cam/fox-1.jpg', start + 3 * hour, [{ label: fox }])]),
    event('cam', [photo('cam/fox-2.jpg', start + 4 * hour, [{ label: fox }])]),
    event('cam', [photo('cam/badger.jpg', start + 5 * hour, [{ label: badger }])]),
    event('cam', [photo('cam/hare.jpg', start + 6 * hour, [{ label: hare }])]),
  ];

  expect(
    reelEndCard(events, { name: 'Deerdiary', pagesUrl: 'https://example.com/deerdiary/' }),
  ).toEqual({
    species: [
      {
        label: deer,
        name: 'white-tailed deer',
        detections: 3,
      },
      {
        label: fox,
        name: 'red fox',
        detections: 2,
      },
      {
        label: badger,
        name: 'eurasian badger',
        detections: 1,
      },
    ],
    dateRange: { first: start, last: start + 6 * hour },
    projectName: 'Deerdiary',
    pagesUrl: 'https://example.com/deerdiary/',
  });
});

test('the end card omits the address when the package has no homepage', () => {
  const card = reelEndCard([], { name: 'Deerdiary' });

  expect(card).toEqual({
    species: [],
    dateRange: null,
    projectName: 'Deerdiary',
    pagesUrl: null,
  });
});

test('the end card checkbox starts on and remembers a deliberate choice', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };

  expect(readIncludeEndCard(undefined)).toBe(true);
  expect(readIncludeEndCard(storage)).toBe(true);
  storeIncludeEndCard(storage, false);
  expect(values.get(REEL_END_CARD_STORAGE_KEY)).toBe('false');
  expect(readIncludeEndCard(storage)).toBe(false);
});

test('the exported reel has whole frames: 348 with the end card and 288 without', () => {
  expect(REEL_FRAME_RATE).toBe(30);
  expect(reelFrameCount(reelDurationMs(8, true))).toBe(348);
  expect(reelFrameCount(reelDurationMs(8, false))).toBe(288);
  expect(reelFrameCount(0)).toBe(0);
});

test('each shot drifts from full size to 104% and the next crossfades in over 300 ms', () => {
  expect(reelLayers(0, 2, false)).toEqual([
    { slide: { kind: 'shot', index: 0 }, opacity: 1, scale: 1 },
  ]);
  expect(reelLayers(600, 2, false)).toEqual([
    { slide: { kind: 'shot', index: 0 }, opacity: 1, scale: 1 + REEL_SCALE_DRIFT / 2 },
  ]);
  expect(reelLayers(REEL_SHOT_MS + REEL_CROSSFADE_MS / 2, 2, false)).toEqual([
    { slide: { kind: 'shot', index: 0 }, opacity: 1, scale: 1 + REEL_SCALE_DRIFT },
    {
      slide: { kind: 'shot', index: 1 },
      opacity: 0.5,
      scale: 1 + REEL_SCALE_DRIFT * (REEL_CROSSFADE_MS / 2 / REEL_SHOT_MS),
    },
  ]);
  expect(reelLayers(REEL_SHOT_MS + REEL_CROSSFADE_MS, 2, false)).toEqual([
    {
      slide: { kind: 'shot', index: 1 },
      opacity: 1,
      scale: 1 + REEL_SCALE_DRIFT * (REEL_CROSSFADE_MS / REEL_SHOT_MS),
    },
  ]);
});

test('the end card fades in after the last shot and holds still until the reel ends', () => {
  const lastShotEnd = 8 * REEL_SHOT_MS;

  expect(reelLayers(lastShotEnd + REEL_CROSSFADE_MS / 3, 8, true)).toEqual([
    { slide: { kind: 'shot', index: 7 }, opacity: 1, scale: 1 + REEL_SCALE_DRIFT },
    { slide: { kind: 'end' }, opacity: 1 / 3, scale: 1 },
  ]);
  expect(reelLayers(10_600, 8, true)).toEqual([{ slide: { kind: 'end' }, opacity: 1, scale: 1 }]);
  expect(reelLayers(lastShotEnd + REEL_END_CARD_MS - 1, 8, true)).toEqual([
    { slide: { kind: 'end' }, opacity: 1, scale: 1 },
  ]);
});

test('times outside the reel clamp to its first and last frames', () => {
  expect(reelLayers(-50, 3, false)).toEqual(reelLayers(0, 3, false));
  expect(reelLayers(reelDurationMs(3, false), 3, false)).toEqual([
    { slide: { kind: 'shot', index: 2 }, opacity: 1, scale: 1 + REEL_SCALE_DRIFT },
  ]);
  expect(reelLayers(500, 0, false)).toEqual([]);
  expect(reelLayers(500, 0, true)).toEqual([]);
});

test('the export asks only for the chosen shots and draws the card only when it is on', () => {
  const start = Date.UTC(2026, 2, 1, 6);
  const events = [
    event('cam', [
      photo('cam/deer-weak.jpg', start, [{ label: deer, conf: 0.5 }]),
      photo('cam/deer-best.jpg', start + 1000, [{ label: deer, conf: 0.99 }]),
    ]),
    event('cam', [photo('cam/fox.jpg', start + hour, [{ label: fox }])]),
    event('cam', [photo('cam/blank.jpg', start + 2 * hour, [{ label: 'blank-uuid;;;;;;blank' }])]),
  ];
  const shots = rankForReel(events);
  const card = reelEndCard(events, { name: 'Deerdiary', pagesUrl: 'https://example.com/d/' });

  expect(reelExportRequest(shots, card, true)).toEqual({
    paths: ['cam/deer-best.jpg', 'cam/fox.jpg'],
    endCard: {
      title: 'Deerdiary',
      lines: [
        'red fox: 1 independent detection',
        'white-tailed deer: 1 independent detection',
        'Mar 1, 2026',
        'https://example.com/d/',
      ],
    },
  });
  expect(reelExportRequest(shots, card, false)).toEqual({
    paths: ['cam/deer-best.jpg', 'cam/fox.jpg'],
    endCard: null,
  });
});
