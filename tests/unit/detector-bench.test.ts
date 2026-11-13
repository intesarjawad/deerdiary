import { expect, test } from 'vitest';
import { agreement, type Predictions, percentile } from '../../tools/bench/detector-metrics';

function predictions(): Predictions {
  return {
    labels: Array.from({ length: 300 }, (_, i) => i % 3),
    boxes: Array.from({ length: 300 }, (_, i) => [i * 20, 0, i * 20 + 10, 10]).flat(),
    scores: Array.from({ length: 300 }, () => 0.8),
  };
}

test('nearest-rank percentiles retain outliers without mutating timings', () => {
  const timings = [100, 3, 2, 1];
  expect(percentile(timings, 0.5)).toBe(2);
  expect(percentile(timings, 0.95)).toBe(100);
  expect(timings).toEqual([100, 3, 2, 1]);
  expect(() => percentile([], 0.5)).toThrow();
  expect(() => percentile([NaN], 0.5)).toThrow();
});

test('agreement tolerates TopK reordering and small numeric differences', () => {
  const expected = predictions();
  const actual = {
    labels: [...expected.labels].reverse(),
    scores: expected.scores.map((value) => value + 0.0005).reverse(),
    boxes: Array.from({ length: 300 }, (_, i) => expected.boxes.slice(i * 4, i * 4 + 4))
      .reverse()
      .flat(),
  };
  expect(agreement(expected, actual)).toMatchObject({ pass: true, matched: 300 });
});

test('agreement rejects wrong classes, duplicate matches and score drift', () => {
  const expected = predictions();
  const actual = predictions();
  actual.labels[0] = 1;
  actual.scores[1] = 0.9;
  actual.boxes.splice(8, 4, ...expected.boxes.slice(20, 24));
  expect(agreement(expected, actual)).toMatchObject({ pass: false, matched: 297 });
  actual.boxes[0] = NaN;
  expect(() => agreement(expected, actual)).toThrow('Invalid xyxy box');
});
