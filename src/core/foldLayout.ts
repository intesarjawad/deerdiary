export type Point = { x: number; y: number; z: number; s: number };

export type FoldMetrics = {
  width: number;
  tileWidth: number;
  tileHeight: number;
  gap: number;
  pad: number;
  /** Room above the tallest pile of a band for its counts. */
  countHeight: number;
  /** Room below a baseline for the species names. */
  nameHeight: number;
  /** Room under the names of a band holding quiet piles for their shared label. */
  labelHeight: number;
  /** Vertical offset between stacked frames of one pile. */
  step: number;
  /** Scale of the small frames that hold nothing counted. */
  noneScale: number;
};

export type Column = { x: number; width: number; top: number; baseline: number; quiet: boolean };

export type Layout = {
  points: Point[];
  height: number;
  /** One per pile, in the order given. */
  columns: Column[];
  /** Where the frames with nothing counted gather, when there are any. */
  none: Column | null;
};

/** One pile of the chart: its frames, kept portrait first, and how many detections it stands for. */
export type PileSpec = { tiles: readonly number[]; slots: number; quiet: boolean };

/** Tiles in shooting order, wrapped into rows: the roll as it came off the card. */
export function stripLayout(count: number, m: FoldMetrics, scale = 1): Layout {
  const w = m.tileWidth * scale;
  const h = m.tileHeight * scale;
  const perRow = Math.max(1, Math.floor((m.width - 2 * m.pad + m.gap) / (w + m.gap)));
  const points = Array.from({ length: count }, (_, index) => ({
    x: m.pad + (index % perRow) * (w + m.gap),
    y: m.pad + Math.floor(index / perRow) * (h + m.gap),
    z: 0,
    s: scale,
  }));
  const rows = Math.ceil(count / perRow);
  const height = 2 * m.pad + Math.max(rows, 1) * (h + m.gap) - m.gap;
  return { points, height, columns: [], none: null };
}

/** The largest tile scale at which the roll is no taller than `limit`, so folding never resizes the plate. */
export function stripScale(count: number, m: FoldMetrics, limit: number): number {
  let scale = 1;
  while (scale > 0.4 && stripLayout(count, m, scale).height > limit) scale -= 0.05;
  return scale;
}

const NONE_UNITS = 2;
const NONE_GAP = 3;
/** The frames stacked under a portrait are this share of its width: thin strips, not a second row. */
const STACK_SCALE = 0.5;
const STACK_GAP = 4;

/**
 * A bar chart made of photographs. Each pile stands on a shared baseline: the kept portrait on top
 * at full width, then one thin strip per further detection, so a bar is as tall as its detection
 * count. Frames beyond one per detection sit behind the strip they belong to. Piles keep the order
 * given (named species first, then the quieter higher-rank labels); the frames with nothing counted
 * sit as small tiles beside the last pile when the width allows, else in a band of their own.
 */
export function foldBars(
  piles: readonly PileSpec[],
  none: readonly number[],
  total: number,
  m: FoldMetrics,
): Layout {
  const unit = m.tileWidth + m.gap;
  const perBand = Math.max(1, Math.floor((m.width - 2 * m.pad + m.gap) / unit));
  const points: Point[] = Array.from({ length: total }, () => ({ x: 0, y: 0, z: 0, s: 1 }));
  const columns: Column[] = [];
  const small = { w: m.tileWidth * m.noneScale, h: m.tileHeight * m.noneScale };
  const noneBlock = (units: number) => {
    const width = units * unit - m.gap;
    const perRow = Math.max(1, Math.floor((width + NONE_GAP) / (small.w + NONE_GAP)));
    const rows = Math.ceil(none.length / perRow);
    return { width, perRow, height: rows * (small.h + NONE_GAP) - NONE_GAP };
  };
  const stackHeight = m.tileHeight * STACK_SCALE;
  const pileHeight = (pile: PileSpec) =>
    pile.slots > 1
      ? m.tileHeight + STACK_GAP + (pile.slots - 2) * m.step + stackHeight
      : m.tileHeight;
  let noneColumn: Column | null = null;
  let top = m.pad;
  const placeNone = (x: number, baseline: number, units: number) => {
    const block = noneBlock(units);
    none.forEach((tile, index) => {
      const row = Math.floor(index / block.perRow);
      points[tile] = {
        x: x + (index % block.perRow) * (small.w + NONE_GAP),
        y: baseline - (row + 1) * (small.h + NONE_GAP) + NONE_GAP,
        z: 0,
        s: m.noneScale,
      };
    });
    noneColumn = { x, width: block.width, top: baseline - block.height, baseline, quiet: false };
  };
  const bands: PileSpec[][] = [];
  for (let first = 0; first < piles.length; first += perBand) {
    bands.push(piles.slice(first, first + perBand));
  }
  if (bands.length === 0) bands.push([]);
  const noneInline = none.length > 0 && (bands.at(-1)?.length ?? 0) + NONE_UNITS <= perBand;
  bands.forEach((band, index) => {
    const withNone = noneInline && index === bands.length - 1;
    const tallest = Math.max(
      ...band.map(pileHeight),
      withNone ? noneBlock(NONE_UNITS).height : 0,
      m.tileHeight,
    );
    const baseline = top + m.countHeight + tallest;
    band.forEach((pile, column) => {
      const x = m.pad + column * unit;
      const pileTop = baseline - pileHeight(pile);
      columns.push({ x, width: m.tileWidth, top: pileTop, baseline, quiet: pile.quiet });
      pile.tiles.forEach((tile, depth) => {
        const behind = depth >= pile.slots;
        const slot = behind ? (depth - pile.slots) % pile.slots : depth;
        const z = pile.slots - slot + (behind ? 0 : pile.slots);
        points[tile] =
          slot === 0
            ? { x, y: pileTop, z, s: 1 }
            : {
                x: x + (m.tileWidth * (1 - STACK_SCALE)) / 2,
                y: pileTop + m.tileHeight + STACK_GAP + (slot - 1) * m.step,
                z,
                s: STACK_SCALE,
              };
      });
    });
    if (withNone) placeNone(m.pad + (perBand - NONE_UNITS) * unit, baseline, NONE_UNITS);
    top =
      baseline + m.nameHeight + m.gap * 2 + (band.some((pile) => pile.quiet) ? m.labelHeight : 0);
  });
  if (none.length > 0 && !noneInline) {
    const block = noneBlock(perBand);
    const baseline = top + block.height;
    placeNone(m.pad, baseline, perBand);
    top = baseline + m.nameHeight + m.gap * 2;
  }
  return { points, height: top - m.gap * 2 + m.pad, columns, none: noneColumn };
}
