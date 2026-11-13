import type { letterboxGeometry } from './letterbox';
import { DETECTION_THRESHOLD, nonMaxSuppression } from './nms';
import type { Detection } from './types';

type Geometry = ReturnType<typeof letterboxGeometry>;

function category(label: number | bigint): Detection['category'] {
  if (label === 0 || label === 0n) return '1';
  if (label === 1 || label === 1n) return '2';
  if (label === 2 || label === 2n) return '3';
  throw new Error(`Unknown detector class: ${label}`);
}

function validateOutput(values: Float32Array, length: number) {
  if (values.length !== length || !values.every(Number.isFinite))
    throw new Error('Invalid detector output shape or nonfinite values');
}

function confidence(value: number): number {
  if (value < 0 || value > 1) throw new Error('Detector confidence must be in 0..1');
  return value;
}

function normalizedBox(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
  height: number,
): Detection['bbox'] {
  if (x2 < x1 || y2 < y1) throw new Error('Detector box corners are reversed');
  return [x1 / width, y1 / height, (x2 - x1) / width, (y2 - y1) / height];
}

/** Deployment outputs already contain sigmoid/top-k and original-image xyxy boxes; no NMS. */
export function decodeRtdetr(
  labels: BigInt64Array,
  boxes: Float32Array,
  scores: Float32Array,
  width: number,
  height: number,
): Detection[] {
  if (labels.length !== 300 || width <= 0 || height <= 0 || !Number.isFinite(width + height))
    throw new Error('Expected 300 RT-DETR queries and positive image dimensions');
  validateOutput(boxes, 1200);
  validateOutput(scores, 300);
  const detections: Detection[] = [];
  for (let i = 0; i < 300; i++) {
    const label = category(labels[i] ?? -1n);
    const conf = confidence(scores[i] ?? 0);
    const bbox = normalizedBox(
      boxes[i * 4] ?? 0,
      boxes[i * 4 + 1] ?? 0,
      boxes[i * 4 + 2] ?? 0,
      boxes[i * 4 + 3] ?? 0,
      width,
      height,
    );
    if (conf > DETECTION_THRESHOLD) detections.push({ category: label, conf, bbox });
  }
  return detections.toSorted((a, b) => b.conf - a.conf);
}

function undoLetterbox(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  geometry: Geometry,
  round: boolean,
): Detection['bbox'] {
  const { srcW, srcH, scale, left, top } = geometry;
  const coordinate = (value: number, pad: number, limit: number) => {
    const clipped = Math.max(0, Math.min(limit, (value - pad) / scale));
    // Reference mode follows scale_boxes then ties-to-even tensor rounding.
    return round
      ? clipped % 1 === 0.5
        ? 2 * Math.round(clipped / 2)
        : Math.round(clipped)
      : clipped;
  };
  return normalizedBox(
    coordinate(x1, round ? (geometry.width - srcW * scale) / 2 : left, srcW),
    coordinate(y1, round ? (geometry.height - srcH * scale) / 2 : top, srcH),
    coordinate(x2, round ? (geometry.width - srcW * scale) / 2 : left, srcW),
    coordinate(y2, round ? (geometry.height - srcH * scale) / 2 : top, srcH),
    srcW,
    srcH,
  );
}

/** Sorrel rows are xyxy/conf/class in letterboxed pixels, with NMS in the graph. */
export function decodeSorrel(rows: Float32Array, geometry: Geometry): Detection[] {
  validateOutput(rows, 300 * 6);
  const detections: Detection[] = [];
  for (let i = 0; i < rows.length; i += 6) {
    const conf = confidence(rows[i + 4] ?? 0);
    const label = category(rows[i + 5] ?? -1);
    if (conf > DETECTION_THRESHOLD)
      detections.push({
        category: label,
        conf,
        bbox: undoLetterbox(
          rows[i] ?? 0,
          rows[i + 1] ?? 0,
          rows[i + 2] ?? 0,
          rows[i + 3] ?? 0,
          geometry,
          false,
        ),
      });
  }
  return detections.toSorted((a, b) => b.conf - a.conf);
}

/** YOLO rows are cx/cy/w/h/objectness plus animal/person/vehicle probabilities. */
export function decodeYolov5(rows: Float32Array, geometry: Geometry): Detection[] {
  if (rows.length % 8 !== 0) throw new Error('Expected YOLOv5 rows of eight values');
  validateOutput(rows, rows.length);
  const candidates: Detection[] = [];
  for (let i = 0; i < rows.length; i += 8) {
    const objectness = confidence(rows[i + 4] ?? 0);
    const probabilities = [rows[i + 5] ?? 0, rows[i + 6] ?? 0, rows[i + 7] ?? 0].map(confidence);
    const best = probabilities.indexOf(Math.max(...probabilities));
    const conf = objectness * (probabilities[best] ?? 0);
    if (conf <= DETECTION_THRESHOLD) continue;
    const x = rows[i] ?? 0;
    const y = rows[i + 1] ?? 0;
    const w = rows[i + 2] ?? 0;
    const h = rows[i + 3] ?? 0;
    if (w < 0 || h < 0) throw new Error('Detector box sizes must be nonnegative');
    candidates.push({ category: category(best), conf, bbox: [x - w / 2, y - h / 2, w, h] });
  }
  return nonMaxSuppression(candidates).map((d) => ({
    ...d,
    bbox: undoLetterbox(
      d.bbox[0],
      d.bbox[1],
      d.bbox[0] + d.bbox[2],
      d.bbox[1] + d.bbox[3],
      geometry,
      true,
    ),
  }));
}
