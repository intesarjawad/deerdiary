import { expect, test } from 'vitest';
import type { DeerdiaryEvent, PhotoResult } from '../../src/core/types';
import { type diarySpecies, rollTiles } from '../../src/ui/Diary';

function photo(path: string): PhotoResult {
  return {
    path,
    detections: [],
    time: { wallClockMs: 0, clockStatus: 'ok' },
  } as unknown as PhotoResult;
}

function eventOf(paths: string[]): DeerdiaryEvent {
  return { cameraKey: 'cam', photos: paths.map(photo), species: [] } as unknown as DeerdiaryEvent;
}

const card = (bestPath: string) =>
  ({ key: bestPath, bestPhoto: photo(bestPath) }) as unknown as ReturnType<
    typeof diarySpecies
  >[number];

test('a small folder shows every frame, numbering the kept ones in ledger order', () => {
  const tiles = rollTiles([eventOf(['a', 'b', 'c'])], [card('c'), card('a')]);
  expect(tiles).toEqual([
    { path: 'a', group: 1, rank: 2 },
    { path: 'b', group: -1 },
    { path: 'c', group: 0, rank: 1 },
  ]);
});

test('a huge folder keeps every kept frame and samples the rest up to the cap', () => {
  const paths = Array.from({ length: 5_000 }, (_, index) => `p${index}`);
  const tiles = rollTiles([eventOf(paths)], [card('p4999'), card('p0')], 100);
  expect(tiles).toHaveLength(100);
  expect(tiles.filter(({ rank }) => rank !== undefined).map(({ path }) => path)).toEqual([
    'p0',
    'p4999',
  ]);
});
