export type Predictions = { labels: number[]; boxes: number[]; scores: number[] };

export function percentile(values: readonly number[], fraction: number): number {
  if (!values.length || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('Expected finite nonnegative timing samples');
  }
  if (fraction <= 0 || fraction > 1) throw new Error('Percentile must be in (0, 1]');
  const sorted = [...values].sort((a, b) => a - b);
  const result = sorted[Math.ceil(fraction * sorted.length) - 1];
  if (result === undefined) throw new Error('Missing percentile sample');
  return result;
}

function boxAt(boxes: number[], index: number): [number, number, number, number] {
  const [x1, y1, x2, y2] = boxes.slice(index * 4, index * 4 + 4);
  if (
    x1 === undefined ||
    y1 === undefined ||
    x2 === undefined ||
    y2 === undefined ||
    ![x1, y1, x2, y2].every(Number.isFinite) ||
    x2 <= x1 ||
    y2 <= y1
  ) {
    throw new Error('Invalid xyxy box');
  }
  return [x1, y1, x2, y2];
}

function iou(left: number[], li: number, right: number[], ri: number): number {
  const [ax, ay, bx, by] = boxAt(left, li);
  const [cx, cy, dx, dy] = boxAt(right, ri);
  const intersection =
    Math.max(0, Math.min(bx, dx) - Math.max(ax, cx)) *
    Math.max(0, Math.min(by, dy) - Math.max(ay, cy));
  return intersection / ((bx - ax) * (by - ay) + (dx - cx) * (dy - cy) - intersection);
}

export function agreement(expected: Predictions, actual: Predictions) {
  for (const value of [expected, actual]) {
    if (
      value.labels.length !== 300 ||
      value.scores.length !== 300 ||
      value.boxes.length !== 1200 ||
      value.labels.some((label) => !Number.isInteger(label) || label < 0 || label > 2) ||
      value.scores.some((score) => !Number.isFinite(score) || score < 0 || score > 1)
    ) {
      throw new Error('Expected 300 valid RT-DETR predictions');
    }
    value.labels.forEach((_, index) => {
      boxAt(value.boxes, index);
    });
  }
  const used = new Set<number>();
  let minMatchedIou = 1;
  let maxMatchedScoreError = 0;
  for (const [index, label] of expected.labels.entries()) {
    const score = expected.scores[index];
    if (score === undefined) throw new Error('Missing reference score');
    let best = -1;
    let overlap = 0;
    let error = 0;
    for (const [candidate, otherScore] of actual.scores.entries()) {
      const difference = Math.abs(score - otherScore);
      if (used.has(candidate) || actual.labels[candidate] !== label || difference > 0.001) continue;
      const candidateIou = iou(expected.boxes, index, actual.boxes, candidate);
      if (candidateIou >= 0.99 && candidateIou > overlap) {
        best = candidate;
        overlap = candidateIou;
        error = difference;
      }
    }
    if (best >= 0) {
      used.add(best);
      minMatchedIou = Math.min(minMatchedIou, overlap);
      maxMatchedScoreError = Math.max(maxMatchedScoreError, error);
    }
  }
  return {
    matched: used.size,
    total: expected.labels.length,
    pass: used.size === expected.labels.length,
    minMatchedIou,
    maxMatchedScoreError,
  };
}
