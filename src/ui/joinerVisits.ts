import { burstCounter, frameRank, groupEvents } from '../core/events';
import type { DeerdiaryEvent, PhotoResult } from '../core/types';
import { restoreSession } from './History';
import { labelCounts, type SpeciesCardData } from './SpeciesCard';

/** Past this share of the frame a box is the lens filled with fur, not an animal in the place. */
const FILLS_LENS = 0.3;
const WINDOW_PAD = 1.25;
const WINDOW_MIN_W = 0.06;
const WINDOW_MIN_H = 0.08;
/** A box this close to the frame's edge holds an animal the frame cuts in two; it gets no print. */
const EDGE = 0.01;
const RANKS = ['class', 'order', 'family', 'genus', 'species'] as const;
// The burnt-in data strip along the top and the maker's mark along the bottom are the camera's.
const STRIP = 0.03;
const BOTTOM_STRIP = 0.025;
const INSET = 0.012;
const OVERLAP = 1.3;
const JITTER = 0.5;
const MAX_TURN_DEG = 2;
// How far fragments on either side of the horizon cross it, so the seam is a line, not a gap.
const SEAM = 0.008;
const GAMMA_MIN = 0.45;
const GAMMA_MAX = 1.6;
// A photo's own white balance moves at most this far, so every fragment keeps its own day.
const WHITE_SHIFT = 0.1;
// The outer band of a print, past this distance from its centre (1 at the edge), is padding around
// the detector's box, so it shows ground the matte is measured against.
const MATTE_RING = 0.75;
// How far a print must differ from its burst's ground to count as the animal, a ramp, in units of
// how much the ring itself differs.
const MATTE_LOW = 1;
const MATTE_HIGH = 2.5;
// Below this coverage the animal stood still through the burst, so the median kept it.
const MATTE_SPARSE = 0.1;
// A piece of the matte smaller than this share of the print is a scrap of changed ground, not the animal.
const MATTE_SCRAP = 0.08;
// Coverage after the blur that closes holes, ramped back to a crisp edge.
const MATTE_FILL = [0.4, 0.7] as const;
// Distance from the centre, 1 at the print's edge, over which it fades out: the detector's box
// is padded by a quarter, so the animal itself ends near 0.8.
const MATTE_EDGE = [0.8, 0.98] as const;
// The filled matte is worn back by this many pixels before its edge is feathered, so a strip of
// changed ground no wider than a limb does not stay attached to the animal.
const MATTE_ERODE = 3;
// Up to this far off the reference's colour a photo keeps its own; from the second it is toned.
const CAST_KEPT = 0.14;
const CAST_TONED = 0.2;
// A crop darker than this, or flatter than this, shows nothing a reader could make out.
const READABLE_MEAN = 0.16;
const READABLE_SPREAD = 0.055;

export type Rank = (typeof RANKS)[number];
export type Rect = readonly [x: number, y: number, width: number, height: number];

export type JoinerVisit = {
  /** 1-based among the bursts that kept an animal; null for a burst with none. */
  number: number | null;
  timeMs: number;
  burstSize: number;
  /** The burst's first photo for an empty burst, otherwise the kept frame. */
  photo: PhotoResult;
  frameIndex: number;
  /** Every frame of the burst, by path, in card order. */
  frames: readonly string[];
  /** Where the visit's print sits on the shared frame, in fractions of the frame; null for none. */
  window: Rect | null;
  name: string | null;
  scientificName: string | null;
  /** The deepest rank the kept label reaches; null when the classifier named nothing. */
  rank: Rank | null;
  /** Other species the burst counted, as the diary does, in the order the burst first shows them. */
  also: readonly VisitName[];
};

export type VisitName = Pick<JoinerVisit, 'name' | 'scientificName' | 'rank'>;

/** The deepest taxonomic rank a SpeciesNet label fills: `uuid;class;order;family;genus;species;name`. */
export function determinedTo(label: string): Rank | null {
  const parts = label.split(';');
  for (let level = RANKS.length; level >= 1; level--) {
    if (parts[level]) return RANKS[level - 1] ?? null;
  }
  return null;
}

/** The detector's box, padded so the animal keeps some of its ground, and kept inside the frame. */
export function visitWindow([x, y, w, h]: Rect): Rect {
  const width = Math.min(1, Math.max(w * WINDOW_PAD, WINDOW_MIN_W));
  const height = Math.min(1, Math.max(h * WINDOW_PAD, WINDOW_MIN_H));
  const left = Math.max(0, Math.min(1 - width, x + w / 2 - width / 2));
  const top = Math.max(0, Math.min(1 - height, y + h / 2 - height / 2));
  return [left, top, width, height];
}

export function cutByEdge([x, y, w, h]: Rect): boolean {
  return x < EDGE || y < STRIP + EDGE || x + w > 1 - EDGE || y + h > 1 - BOTTOM_STRIP - EDGE;
}

/**
 * One visit per burst, in card order. A burst's window is its frame whose best counted box is the
 * largest that does not fill the lens, so the animal is seen standing where the camera saw it.
 */
export function joinerVisits(
  events: readonly DeerdiaryEvent[],
  cards: readonly SpeciesCardData[],
): JoinerVisit[] {
  let number = 0;
  return events.map((event) => {
    const counted = burstCounter(event.photos);
    let kept: { photo: PhotoResult; bbox: Rect; label: string; area: number } | undefined;
    for (const photo of event.photos) {
      const best = photo.detections
        .map((detection) => ({ detection, label: counted(detection) }))
        .filter((hit): hit is typeof hit & { label: string } => hit.label !== undefined)
        .toSorted((a, b) => frameRank(b.detection) - frameRank(a.detection))[0];
      if (!best) continue;
      const area = best.detection.bbox[2] * best.detection.bbox[3];
      if (area < FILLS_LENS && (!kept || area > kept.area)) {
        kept = { photo, bbox: best.detection.bbox, label: best.label, area };
      }
    }
    const first = event.photos[0] as PhotoResult;
    const timeMs = first.time.wallClockMs;
    const burstSize = event.photos.length;
    if (!kept) {
      return {
        number: null,
        timeMs,
        burstSize,
        photo: first,
        frameIndex: 0,
        frames: event.photos.map(({ path }) => path),
        window: null,
        name: null,
        scientificName: null,
        rank: null,
        also: [],
      };
    }
    const { label } = kept;
    const cardOf = (counted: string) => cards.find(({ labels }) => labels.includes(counted));
    const card = cardOf(label);
    const also = new Map<string, VisitName>();
    for (const photo of event.photos) {
      for (const detection of photo.detections) {
        const other = counted(detection);
        if (other === undefined) continue;
        const named = cardOf(other);
        const key = named?.key ?? other;
        if (named === card || also.has(key)) continue;
        also.set(key, {
          name: named?.name ?? null,
          scientificName: named?.scientificName ?? null,
          rank: determinedTo(other),
        });
      }
    }
    number += 1;
    return {
      number,
      timeMs,
      burstSize,
      photo: kept.photo,
      frameIndex: event.photos.indexOf(kept.photo),
      frames: event.photos.map(({ path }) => path),
      window: cutByEdge(kept.bbox) ? null : visitWindow(kept.bbox),
      name: card?.name ?? null,
      scientificName: card?.scientificName ?? null,
      rank: determinedTo(label),
      also: [...also.values()],
    };
  });
}

/** The bursts of a saved session, grouped by the same code the diary uses; undefined if unreadable. */
export function sessionEvents(text: string): DeerdiaryEvent[] | undefined {
  const restored = restoreSession(text);
  if (!restored.ok) return undefined;
  return groupEvents(
    restored.value.results.flatMap(({ output, time }) =>
      output.status === 'ok' ? [{ path: output.path, time, detections: output.detections }] : [],
    ),
  );
}

/** The labels reached so far, counted as the diary counts them, and the bursts with no animal. */
export function sheetTallies(visits: readonly JoinerVisit[]) {
  const labels = new Map<string, { species: boolean; detections: number }>();
  for (const { name, rank } of visits.flatMap((visit) =>
    visit.number === null ? [] : [visit, ...visit.also],
  )) {
    const label = labels.get(name ?? '') ?? { species: rank === 'species', detections: 0 };
    label.detections += 1;
    labels.set(name ?? '', label);
  }
  return {
    ...labelCounts([...labels.values()]),
    empty: visits.filter(({ number }) => number === null).length,
  };
}

export type Fragment = { rect: Rect; turnDeg: number };

/** A stable value in [0, 1) for a fragment, so the joiner is laid the same way on every load. */
function scatter(index: number, salt: number): number {
  const value = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

/** How far a print is turned, within two degrees either way, for print number `seed`. */
export function turnOf(seed: number): number {
  return (scatter(seed, 3) * 2 - 1) * MAX_TURN_DEG;
}

// By day prints are laid as a hand lays them: from 0.6 to 1.6 times their size, pushed this much
// further from the frame's centre, and never wider or taller than these fractions of the frame.
const PRINT_SCALE = [0.6, 1.6] as const;
const PRINT_SPREAD = 1.35;
const PRINT_MAX = [0.4, 0.45] as const;

/**
 * Where a print lies in the finished joiner. At night it is registered with the scene, so its
 * flash lands where the animal stood; by day it is laid by hand, scaled and spread toward the
 * frame's edges so the prints reach the corners, and kept inside the frame between its strips.
 */
export function laidRect(
  [x, y, w, h]: readonly [number, number, number, number],
  index: number,
): [number, number, number, number] {
  const top = STRIP + INSET;
  const bottom = 1 - BOTTOM_STRIP - INSET;
  const middle = (top + bottom) / 2;
  const wanted = PRINT_SCALE[0] + (PRINT_SCALE[1] - PRINT_SCALE[0]) * scatter(index, 5);
  const scale = Math.min(wanted, PRINT_MAX[0] / w, PRINT_MAX[1] / h);
  const [lw, lh] = [w * scale, h * scale];
  const cx = 0.5 + (x + w / 2 - 0.5) * PRINT_SPREAD;
  const cy = middle + (y + h / 2 - middle) * PRINT_SPREAD;
  return [
    Math.min(1 - INSET - lw, Math.max(INSET, cx - lw / 2)),
    Math.min(bottom - lh, Math.max(top, cy - lh / 2)),
    lw,
    lh,
  ];
}

/**
 * Overlapping fragments that cover the frame below the data strip, each turned by up to two degrees,
 * as prints laid by hand. Rows are near one height above and below the scene's horizon, where the
 * ground meets the far bank, and one row ends on it, so that seam is the scene's own edge; every
 * other row starts half a print over, as bricks are laid, so no seam runs down the frame. Every
 * rect stays inside the frame.
 */
export function fragmentGrid(cols: number, rows: number, horizon: number): Fragment[] {
  const top = STRIP + INSET;
  const bottom = 1 - BOTTOM_STRIP - INSET;
  const above = Math.min(
    rows - 1,
    Math.max(1, Math.round(((horizon - top) / (bottom - top)) * rows)),
  );
  const edges = Array.from({ length: rows + 1 }, (_, row) =>
    row <= above
      ? top + ((horizon - top) * row) / above
      : horizon + ((bottom - horizon) * (row - above)) / (rows - above),
  );
  const cellW = (1 - 2 * INSET) / cols;
  const fragments: Fragment[] = [];
  for (let row = 0; row < rows; row++) {
    const y0 = edges[row] ?? top;
    const y1 = edges[row + 1] ?? bottom;
    const shift = row % 2 === 1 ? 0.5 : 0;
    for (let col = 0; col < cols + (row % 2); col++) {
      const index = row * (cols + 1) + col;
      const w = cellW * (OVERLAP + (scatter(index, 1) - 0.5) * JITTER);
      const cx = INSET + (col - shift + 0.5) * cellW;
      const x = Math.max(INSET, Math.min(1 - INSET - w, cx - w / 2));
      // Each fragment reaches past its row by its own amount, so the pieces are not one size.
      const pad = ((y1 - y0) * (OVERLAP - 1) * (0.5 + scatter(index, 2))) / 2;
      // The rows on the horizon only cross it by a seam, so the far bank keeps its own edge.
      const y = Math.max(top, y0 - (row === above ? SEAM : pad));
      const end = Math.min(bottom, y1 + (row === above - 1 ? SEAM : pad));
      fragments.push({ rect: [x, y, w, end - y], turnDeg: turnOf(index) });
    }
  }
  return fragments;
}

export function farthestRow(
  depth: ArrayLike<number>,
  width: number,
  from: number,
  to: number,
): number {
  const height = Math.floor(depth.length / width);
  let best = from;
  let lowest = Number.POSITIVE_INFINITY;
  for (let row = Math.ceil(from * height); row < Math.floor(to * height); row++) {
    const values = Array.from({ length: width }, (_, col) => depth[row * width + col] ?? 0).sort(
      (a, b) => a - b,
    );
    const median = values[width >> 1] ?? 0;
    if (median < lowest) {
      lowest = median;
      best = row / height;
    }
  }
  return best;
}

export type Grade = {
  gamma: number;
  tint: readonly [number, number, number];
  /** The reference's colour per unit of brightness, which a monochrome print is toned with. */
  tone: readonly [number, number, number];
  /** 1 keeps the photo's own colour, corrected by `tint`; 0 keeps only its tones, in `tone`. */
  keep: number;
};

const luma = ([r, g, b]: readonly [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * How to bring a photo toward the reference's light: a gamma that moves its mean brightness half
 * way to the reference's, so the seams keep the exposure steps a joiner's prints have, and
 * per-channel gains toward the reference's colour cast, held within a tenth so each photo keeps its
 * own white balance. A large cast, as on a monochrome infrared frame or one whose colour failed
 * unevenly from shadow to highlight, cannot be corrected, so that photo keeps only its tones,
 * warmed by at most a tenth toward the reference's white, as a print is toned in the darkroom.
 */
export function gradeFor(
  mean: readonly [number, number, number],
  reference: readonly [number, number, number],
  white: readonly [number, number, number],
): Grade {
  const level = Math.min(Math.max(luma(mean), 0.01), 0.99);
  const target = luma(reference);
  const matched = Math.log(target) / Math.log(level);
  const gamma = Math.min(GAMMA_MAX, Math.max(GAMMA_MIN, (1 + matched) / 2));
  const shift = (gain: number) => Math.min(1 + WHITE_SHIFT, Math.max(1 - WHITE_SHIFT, gain));
  const ratio = (channel: 0 | 1 | 2) =>
    reference[channel] / target / (Math.max(mean[channel], 0.01) / level);
  const full = [ratio(0), ratio(1), ratio(2)] as const;
  const cast = Math.max(...full.map((gain) => Math.abs(gain - 1)));
  return {
    gamma,
    tint: [shift(full[0]), shift(full[1]), shift(full[2])],
    tone: [
      shift(white[0] / luma(white)),
      shift(white[1] / luma(white)),
      shift(white[2] / luma(white)),
    ],
    keep: Math.min(1, Math.max(0, 1 - (cast - CAST_KEPT) / (CAST_TONED - CAST_KEPT))),
  };
}

/** Applies a grade to RGBA pixels in place. */
export function applyGrade(rgba: Uint8ClampedArray, { gamma, tint, tone, keep }: Grade): void {
  // The lift depends only on brightness, so it is worked out once per 8-bit level, not per pixel.
  const lifts = Float32Array.from({ length: 256 }, (_, level) =>
    level > 0 ? (level / 255) ** gamma / (level / 255) : 0,
  );
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i] ?? 0;
    const g = rgba[i + 1] ?? 0;
    const b = rgba[i + 2] ?? 0;
    const level = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const lift = lifts[level] ?? 0;
    const lifted = level * lift;
    rgba[i] = keep * r * lift * tint[0] + (1 - keep) * lifted * tone[0];
    rgba[i + 1] = keep * g * lift * tint[1] + (1 - keep) * lifted * tone[1];
    rgba[i + 2] = keep * b * lift * tint[2] + (1 - keep) * lifted * tone[2];
  }
}

const ramp = (low: number, high: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
};

/** One pass of a running box mean of `radius`, along the rows or down the columns. */
function boxPass(
  values: Float32Array,
  width: number,
  height: number,
  radius: number,
  rows: boolean,
) {
  const out = new Float32Array(values.length);
  const [lines, length] = rows ? [height, width] : [width, height];
  for (let line = 0; line < lines; line++) {
    const at = (k: number) => (rows ? line * width + k : k * width + line);
    let sum = 0;
    for (let k = -radius; k <= radius; k++)
      sum += values[at(Math.min(length - 1, Math.max(0, k)))] ?? 0;
    for (let k = 0; k < length; k++) {
      out[at(k)] = sum / (2 * radius + 1);
      sum +=
        (values[at(Math.min(length - 1, k + radius + 1))] ?? 0) -
        (values[at(Math.max(0, k - radius))] ?? 0);
    }
  }
  return out;
}

/**
 * Where an animal is in its print. The camera never moves and a burst takes a few seconds, so the
 * burst's other frames show the same ground in the same light; the animal is what differs from
 * their median. Each channel of that ground is fitted to the print's on the ring of padding, the
 * difference is measured against how much the ring itself differs, blurred to close the holes
 * where fur matches the ground, ramped back to a crisp edge and faded out before the print's
 * edges. When the animal held still, the median keeps it, so the matte falls back to what differs
 * from any one of the frames. All inputs are RGBA crops of the same size.
 */
export function animalMatte(
  print: ArrayLike<number>,
  frames: readonly ArrayLike<number>[],
  width: number,
  height: number,
): Float32Array {
  const count = width * height;
  const radius = Math.max(2, Math.round(Math.min(width, height) / 40));
  const smooth = Math.max(1, radius >> 1);
  const edge = Float32Array.from({ length: count }, (_, i) =>
    Math.max(
      Math.abs((2 * ((i % width) + 0.5)) / width - 1),
      Math.abs((2 * (Math.floor(i / width) + 0.5)) / height - 1),
    ),
  );
  const ring = [...edge.keys()].filter((i) => (edge[i] ?? 0) > MATTE_RING);
  const blur = (values: Float32Array) =>
    boxPass(boxPass(values, width, height, smooth, true), width, height, smooth, false);
  const channel = (rgba: ArrayLike<number>, c: number) =>
    blur(Float32Array.from({ length: count }, (_, i) => rgba[i * 4 + c] ?? 0));
  const ours = [0, 1, 2].map((c) => channel(print, c));
  /** One channel of another frame brought to the print's level on the ring, which is ground. */
  const fitted = (mine: Float32Array, theirs: Float32Array) => {
    let [sa, sb, sab, sbb] = [0, 0, 0, 0];
    for (const i of ring) {
      const [a, b] = [mine[i] ?? 0, theirs[i] ?? 0];
      sa += a;
      sb += b;
      sab += a * b;
      sbb += b * b;
    }
    const n = Math.max(ring.length, 1);
    const spread = sbb / n - (sb / n) ** 2;
    const gain = spread > 1e-6 ? (sab / n - (sa / n) * (sb / n)) / spread : 0;
    const offset = sa / n - gain * (sb / n);
    return theirs.map((value) => gain * value + offset);
  };
  const distance = (ground: Float32Array[]) => {
    const out = new Float32Array(count);
    for (const [c, mine] of ours.entries()) {
      const theirs = fitted(mine, ground[c] ?? new Float32Array(count));
      for (let i = 0; i < count; i++)
        out[i] = (out[i] ?? 0) + ((mine[i] ?? 0) - (theirs[i] ?? 0)) ** 2;
    }
    return out.map(Math.sqrt);
  };
  const box = (values: Float32Array, r: number) =>
    boxPass(boxPass(values, width, height, r, true), width, height, r, false);
  const finish = (distance: Float32Array) => {
    const band = Float32Array.from(ring, (i) => distance[i] ?? 0).sort();
    const middle = band[band.length >> 1] ?? 0;
    const { spread } = exposure(band);
    const raw = distance.map((value) =>
      ramp(MATTE_LOW, MATTE_HIGH, (value - middle) / Math.max(spread, 1)),
    );
    return box(raw, radius).map((value) => ramp(...MATTE_FILL, value));
  };
  // Scraps go first, measured at the animal's full size; then the edge is worn back and feathered.
  const wear = (matte: Float32Array) => {
    const kept = withoutScraps(matte, width, height);
    // Only where the whole neighbourhood is animal does the eroded matte stay whole.
    const eroded = box(kept, MATTE_ERODE).map((value) => ramp(0.8, 1, value));
    return box(eroded, 1).map((value, i) => value * (1 - ramp(...MATTE_EDGE, edge[i] ?? 0)));
  };
  // Every frame is first brought to the print's light, so a burst whose light changed between
  // frames still agrees on what the ground looks like.
  const median = ours.map((mine, c) => {
    const stack = [mine, ...frames.map((frame) => fitted(mine, channel(frame, c)))];
    const values = new Float32Array(stack.length);
    return Float32Array.from({ length: count }, (_, i) => {
      for (const [k, layer] of stack.entries()) values[k] = layer[i] ?? 0;
      return values.sort()[stack.length >> 1] ?? 0;
    });
  });
  const matte = finish(distance(median));
  if (exposure(matte).mean >= MATTE_SPARSE || frames.length === 0) {
    return wear(matte);
  }
  const apart = frames.map((frame) => distance([0, 1, 2].map((c) => channel(frame, c))));
  return wear(
    finish(apart.reduce((most, next) => most.map((value, i) => Math.max(value, next[i] ?? 0)))),
  );
}

/**
 * Per-channel gains that bring a print's ring of padding, which is ground, to the level of the
 * ground around it in another photo of the same spot, so the ground a soft matte keeps at its edge
 * does not show as a paler or darker patch. Both inputs are RGBA crops of the same size.
 */
export function ringGains(
  print: ArrayLike<number>,
  ground: ArrayLike<number>,
  width: number,
  height: number,
): [number, number, number] {
  const sums = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < width * height; i++) {
    const x = Math.abs((2 * ((i % width) + 0.5)) / width - 1);
    const y = Math.abs((2 * (Math.floor(i / width) + 0.5)) / height - 1);
    if (Math.max(x, y) <= MATTE_RING) continue;
    for (let c = 0; c < 3; c++) {
      sums[c] = (sums[c] ?? 0) + (print[i * 4 + c] ?? 0);
      sums[c + 3] = (sums[c + 3] ?? 0) + (ground[i * 4 + c] ?? 0);
    }
  }
  const gain = (c: number) => ((sums[c + 3] ?? 0) + 1) / ((sums[c] ?? 0) + 1);
  return [gain(0), gain(1), gain(2)];
}

/** Clears every connected piece of a matte smaller than MATTE_SCRAP of the print, in place. */
function withoutScraps(matte: Float32Array, width: number, height: number): Float32Array {
  const seen = new Uint8Array(matte.length);
  for (let start = 0; start < matte.length; start++) {
    if (seen[start] || (matte[start] ?? 0) <= 0) continue;
    const piece = [start];
    seen[start] = 1;
    let solid = 0;
    for (let k = 0; k < piece.length; k++) {
      const i = piece[k] ?? 0;
      if ((matte[i] ?? 0) > 0.5) solid += 1;
      const x = i % width;
      for (const next of [
        x > 0 ? i - 1 : -1,
        x < width - 1 ? i + 1 : -1,
        i - width,
        i + width < matte.length ? i + width : -1,
      ]) {
        if (next < 0 || seen[next] || (matte[next] ?? 0) <= 0) continue;
        seen[next] = 1;
        piece.push(next);
      }
    }
    if (solid < MATTE_SCRAP * width * height) for (const i of piece) matte[i] = 0;
  }
  return matte;
}

/**
 * Which photo each fragment is cut from: the best-scored photo for that spot, taking fragments in
 * order of how good their best photo is, and using no photo for more than `cap` fragments.
 */
export function assignFragments(scores: readonly (readonly number[])[], cap: number): number[] {
  const cells = scores[0]?.length ?? 0;
  const used = new Array<number>(scores.length).fill(0);
  const chosen = new Array<number>(cells).fill(-1);
  const pairs = scores
    .flatMap((row, photo) => row.map((score, cell) => ({ photo, cell, score })))
    .toSorted((a, b) => b.score - a.score);
  for (const { photo, cell } of pairs) {
    if (chosen[cell] !== -1 || (used[photo] ?? 0) >= cap) continue;
    chosen[cell] = photo;
    used[photo] = (used[photo] ?? 0) + 1;
  }
  return chosen;
}

/** Mean and spread of luminance values in [0, 1]. */
export function exposure(values: ArrayLike<number>): { mean: number; spread: number } {
  let sum = 0;
  let squares = 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i] ?? 0;
    sum += value;
    squares += value * value;
  }
  const mean = sum / Math.max(values.length, 1);
  return {
    mean,
    spread: Math.sqrt(Math.max(squares / Math.max(values.length, 1) - mean * mean, 0)),
  };
}

/** True when a crop shows something: bright enough and with enough in it to make out a shape. */
export function readable(values: ArrayLike<number>): boolean {
  const { mean, spread } = exposure(values);
  return mean >= READABLE_MEAN && spread >= READABLE_SPREAD;
}
