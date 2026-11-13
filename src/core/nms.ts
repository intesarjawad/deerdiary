import type { Detection } from './types';

export const NMS_IOU = 0.45;
export const MAX_DETECTIONS = 300;
export const DETECTION_THRESHOLD = 0.01;

function overlapArea(a: Detection['bbox'], b: Detection['bbox']): number {
  return (
    Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]))
  );
}

export function intersectionOverUnion(a: Detection['bbox'], b: Detection['bbox']): number {
  const overlap = overlapArea(a, b);
  const union = a[2] * a[3] + b[2] * b[3] - overlap;
  return union > 0 ? overlap / union : 0;
}

/** The share of the smaller box that lies inside the other: 1 when one box encloses the other. */
export function intersectionOverSmaller(a: Detection['bbox'], b: Detection['bbox']): number {
  const smaller = Math.min(a[2] * a[3], b[2] * b[3]);
  return smaller > 0 ? overlapArea(a, b) / smaller : 0;
}

/** Greedy, class-aware suppression in descending confidence order. */
export function nonMaxSuppression(detections: readonly Detection[]): Detection[] {
  const kept: Detection[] = [];
  for (const detection of detections
    .filter((d) => d.conf > DETECTION_THRESHOLD)
    .toSorted((a, b) => b.conf - a.conf)) {
    if (
      kept.every(
        (other) =>
          other.category !== detection.category ||
          intersectionOverUnion(other.bbox, detection.bbox) <= NMS_IOU,
      )
    )
      kept.push(detection);
    if (kept.length === MAX_DETECTIONS) break;
  }
  return kept;
}
