import { expect, test } from 'vitest';
import { foldBars, stripLayout, stripScale } from '../../src/core/foldLayout';

const metrics = {
  width: 600,
  tileWidth: 60,
  tileHeight: 45,
  gap: 6,
  pad: 8,
  countHeight: 24,
  labelHeight: 20,
  nameHeight: 40,
  step: 20,
  noneScale: 0.5,
};

test('the strip wraps tiles into rows that fit the width without overlap', () => {
  const { points, height } = stripLayout(23, metrics);
  expect(new Set(points.map(({ x, y }) => `${x},${y}`)).size).toBe(23);
  for (const { x, y } of points) {
    expect(x + metrics.tileWidth).toBeLessThanOrEqual(metrics.width - metrics.pad);
    expect(y + metrics.tileHeight).toBeLessThanOrEqual(height);
  }
});

const pile = (tiles: number[], slots = tiles.length, quiet = false) => ({ tiles, slots, quiet });

test('bars stand on one baseline and are as tall as their detection count', () => {
  const { points, columns } = foldBars(
    [pile([3, 0, 1, 6]), pile([2, 7]), pile([4])],
    [5],
    8,
    metrics,
  );
  expect(new Set(columns.map(({ baseline }) => baseline)).size).toBe(1);
  const [tall, mid, one] = columns.map(({ top, baseline }) => baseline - top);
  expect(one).toBe(45);
  expect(mid).toBeLessThan(tall ?? 0);
  expect((tall ?? 0) - (mid ?? 0)).toBe(2 * 20);
  expect(points[3]?.y).toBe(columns[0]?.top);
});

test('frames beyond one per detection sit behind their strip and are never above it', () => {
  const { points } = foldBars([pile([0, 1, 2, 3], 2)], [], 4, metrics);
  expect(points[2]).toMatchObject({ x: points[0]?.x, y: points[0]?.y, s: 1 });
  expect(points[3]).toMatchObject({ x: points[1]?.x, y: points[1]?.y, s: 0.5 });
  expect(points[2]?.z).toBeLessThan(points[0]?.z ?? 0);
  expect(points[3]?.z).toBeLessThan(points[1]?.z ?? 0);
});

test('every kept portrait is full width and frames with nothing counted shrink beside the bars', () => {
  const { points, none } = foldBars([pile([0, 1]), pile([2])], [3, 4, 5], 6, metrics);
  expect(points[0]?.s).toBe(1);
  expect(points[1]?.s).toBe(0.5);
  expect(points[3]?.s).toBe(0.5);
  expect(none).not.toBeNull();
});

test('quiet piles keep their flag and bars wrap into bands when the columns do not fit', () => {
  const piles = Array.from({ length: 12 }, (_, index) => pile([index], 1, index > 8));
  const { points, columns, none, height } = foldBars(piles, [12, 13], 14, {
    ...metrics,
    width: 260,
  });
  expect(columns.filter(({ quiet }) => quiet)).toHaveLength(3);
  expect(new Set(columns.map(({ baseline }) => baseline)).size).toBeGreaterThan(1);
  expect(none?.baseline).toBeGreaterThan(columns[0]?.baseline ?? 0);
  for (const { y } of points) expect(y).toBeLessThan(height);
});

test('the roll shrinks until it is no taller than the chart, so folding never resizes the plate', () => {
  const full = stripLayout(60, metrics).height;
  const scale = stripScale(60, metrics, full / 2);
  expect(scale).toBeLessThan(1);
  expect(stripLayout(60, metrics, scale).height).toBeLessThanOrEqual(full / 2);
  expect(stripScale(5, metrics, full)).toBe(1);
});
