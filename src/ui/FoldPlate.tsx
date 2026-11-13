import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import {
  type FoldMetrics,
  foldBars,
  type Layout,
  type PileSpec,
  stripLayout,
  stripScale,
} from '../core/foldLayout';
import { Portrait, TINY_SUBJECT_PX } from './Portrait';
import { labelCounts } from './SpeciesCard';

const count = new Intl.NumberFormat('en-US');
const EASE = 'cubic-bezier(0.2, 0.7, 0.2, 1)';
const FOLD_DELAY_MS = 1000;
const FOLD_MS = 900;
const PILE_STAGGER_MS = 95;
const DEPTH_STAGGER_MS = 28;
const RELAYOUT_MS = 240;
const ZOOM_MS = 700;
const FACE_COUNT = 3;
const FACE_STAGGER_MS = 260;
const PHONE_WIDTH = 520;
const PHONE_COLUMNS = 3;

export type FoldTile = {
  path: string;
  /** Index of the species pile the frame belongs to, or -1 when nothing in it was counted. */
  group: number;
  /** Position in the ledger when the diary kept this frame for its species. */
  rank?: number | undefined;
  /** The detection box of a kept frame, normalized to the image, so the pile can zoom to it. */
  focus?: readonly [number, number, number, number] | undefined;
};

export type FoldGroup = {
  rank: number;
  name: string;
  detections: number;
  /** False for labels above species rank, which sit apart and are not counted as species. */
  species: boolean;
};

export type FoldPlateProps = {
  tiles: readonly FoldTile[];
  groups: readonly FoldGroup[];
  frames: number;
  thumbnailURL?: ((path: string) => string | undefined) | undefined;
  /** Full-size frames for the portraits, which are shown larger than a thumbnail can carry. */
  photoURL?: ((path: string) => string | undefined) | undefined;
  /** The original frame, when this page still holds it; portraits are cut from it. */
  originalURL?: ((path: string) => string | undefined) | undefined;
  /** The diary has no folder open, so the portraits are cut from small previews. */
  originalsMissing?: boolean | undefined;
  onAddFolder?: (() => void) | undefined;
  onSelect?: (rank: number) => void;
};

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The scale-then-shift that fills a tile with a window of the image around a detection box. */
export function zoomTransform([x, y, w, h]: readonly [number, number, number, number]): string {
  const window = Math.min(1, Math.max(0.2, Math.max(w, h) * 1.9));
  const left = Math.min(Math.max(x + w / 2 - window / 2, 0), 1 - window);
  const top = Math.min(Math.max(y + h / 2 - window / 2, 0), 1 - window);
  return `scale(${1 / window}) translate(${-left * 100}%, ${-top * 100}%)`;
}

/** How many lines a name takes when wrapped at word boundaries into a column of `chars` letters. */
export function nameLines(name: string, chars: number): number {
  let lines = 1;
  let used = 0;
  for (const word of name.split(' ')) {
    const needed = Math.ceil(word.length / chars);
    if (used > 0 && used + 1 + word.length <= chars) used += 1 + word.length;
    else {
      if (used > 0) lines += 1;
      lines += needed - 1;
      used = word.length - (needed - 1) * chars;
    }
  }
  return lines;
}

/** True when a label holds a word that cannot fit a column of `chars` letters. */
export function longWord(name: string, chars: number): boolean {
  return name.split(' ').some((word) => word.length > chars);
}

/** A box that touches no frame edge and is not a close-up of fur. */
function wholeBody([x, y, w, h]: readonly [number, number, number, number]): boolean {
  const edge = 0.01;
  return x > edge && y > edge && x + w < 1 - edge && y + h < 1 - edge && w * h <= 0.25;
}

/** Roughly how many letters of a label fit the column. */
function columnChars(tileWidth: number): number {
  return Math.max(5, Math.floor(tileWidth / 6.6));
}

function metricsFor(width: number, columns: number, names: readonly string[]): FoldMetrics {
  const gap = 6;
  const pad = 14;
  // A phone gets three columns of about 100px; a wide screen fits every pile in one band.
  const across = width < PHONE_WIDTH ? PHONE_COLUMNS : columns + 2;
  const fitted = Math.floor((width - 2 * pad + gap) / across) - gap;
  const tileWidth = Math.max(46, Math.min(fitted, 150));
  const tileHeight = Math.round(tileWidth * 0.75);
  const chars = columnChars(tileWidth);
  const lines = Math.max(2, ...names.map((name) => nameLines(name, chars)));
  return {
    width,
    tileWidth,
    tileHeight,
    gap,
    pad,
    countHeight: 26,
    labelHeight: 30,
    nameHeight: lines * 15 + 12,
    step: Math.round(tileWidth * 0.2),
    noneScale: 0.36,
  };
}

const transformOf = ({ x, y, s }: { x: number; y: number; s: number }) =>
  `translate(${x}px, ${y}px) scale(${s})`;

/**
 * The roll of every frame, and the bar chart of photographs it folds into. The fold is a FLIP: each
 * tile animates from where it is to where it lands, with its start state held through its delay so
 * no tile ever vanishes. Only transforms move, a fold interrupted by a click starts from wherever
 * the tiles are, and under reduced motion the chart simply appears.
 */
export function FoldPlate({
  tiles,
  groups,
  frames,
  thumbnailURL,
  photoURL,
  originalURL,
  originalsMissing = false,
  onAddFolder,
  onSelect,
}: FoldPlateProps) {
  const root = useRef<HTMLDivElement>(null);
  const items = useRef(new Map<string, HTMLLIElement>());
  const placed = useRef(new Set<string>());
  const timers = useRef<number[]>([]);
  const firstRun = useRef(true);
  const mode = useRef<'strip' | 'bars'>('strip');
  const [folded, setFolded] = useState(() => reducedMotion());
  const [landed, setLanded] = useState(() =>
    reducedMotion() ? groups.filter((group) => group.species).length : 0,
  );
  const [width, setWidth] = useState(0);
  const [readout, setReadout] = useState<number | null>(null);
  const [naturals, setNaturals] = useState<Record<string, readonly [number, number]>>({});
  // Kept frames that have loaded or failed; the roll folds once all have, so no pile lands empty.
  const [settled, setSettled] = useState<ReadonlySet<string>>(() => new Set());
  const settle = (path: string) =>
    setSettled((known) => (known.has(path) ? known : new Set(known).add(path)));
  const sourceOf = (tile: FoldTile) =>
    (tile.rank !== undefined ? (originalURL?.(tile.path) ?? photoURL?.(tile.path)) : undefined) ??
    thumbnailURL?.(tile.path);
  const ready = tiles.every(
    (tile) => tile.rank === undefined || settled.has(tile.path) || !sourceOf(tile),
  );

  const members = (group: number) =>
    tiles.flatMap((tile, index) => (tile.group === group ? [index] : []));
  const piles = groups
    .map((info, group) => {
      const own = members(group).toSorted(
        (x, y) => Number(tiles[y]?.rank !== undefined) - Number(tiles[x]?.rank !== undefined),
      );
      return {
        group,
        tiles: own,
        slots: Math.max(1, Math.min(info.detections, own.length)),
        quiet: !info.species,
      };
    })
    .filter((pile) => pile.tiles.length > 0)
    .toSorted(
      (a, b) =>
        Number(a.quiet) - Number(b.quiet) ||
        (groups[b.group]?.detections ?? 0) - (groups[a.group]?.detections ?? 0) ||
        a.group - b.group,
    );
  const { named, broader: quietDetections } = labelCounts(
    piles.map((pile) => ({
      species: !pile.quiet,
      detections: groups[pile.group]?.detections ?? 0,
    })),
  );
  const noneTiles = members(-1);

  const metrics = metricsFor(
    width || 960,
    piles.length,
    piles.map((pile) => groups[pile.group]?.name ?? ''),
  );
  const bars: Layout | null =
    width === 0
      ? null
      : foldBars(
          piles.map<PileSpec>(({ tiles: own, slots, quiet }) => ({ tiles: own, slots, quiet })),
          noneTiles,
          tiles.length,
          metrics,
        );

  const strip =
    width === 0 || bars === null
      ? null
      : stripLayout(tiles.length, metrics, stripScale(tiles.length, metrics, bars.height));

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const delayOf = new Map<number, number>();
  piles.forEach((pile, order) => {
    pile.tiles.forEach((tile, depth) => {
      delayOf.set(tile, order * PILE_STAGGER_MS + depth * DEPTH_STAGGER_MS);
    });
  });
  noneTiles.forEach((tile, index) => {
    delayOf.set(tile, Math.min(index * 10, 400));
  });

  // A word longer than its column is hyphenated at a real syllable where the browser knows how;
  // where it does not, the word overflows its label and the label is scaled down to fit.
  useLayoutEffect(() => {
    if (!folded) return;
    for (const label of root.current?.querySelectorAll<HTMLElement>('.pile-name-text.is-long') ??
      []) {
      label.style.fontSize = '';
      if (label.scrollWidth > label.clientWidth + 1) {
        label.style.fontSize = `${Math.max(0.55, label.clientWidth / label.scrollWidth).toFixed(3)}em`;
      }
    }
  }, [folded, width, groups]);

  useLayoutEffect(() => {
    if (width === 0) return;
    const next = folded ? bars : strip;
    if (!next) return;
    const animate = !reducedMotion();
    const modeChanged = mode.current !== (folded ? 'bars' : 'strip');
    mode.current = folded ? 'bars' : 'strip';
    tiles.forEach((tile, index) => {
      const element = items.current.get(tile.path);
      const point = next.points[index];
      if (!element || !point) return;
      const to = transformOf(point);
      element.style.width = `${metrics.tileWidth}px`;
      element.style.height = `${metrics.tileHeight}px`;
      element.style.zIndex = String(point.z);
      const known = placed.current.has(tile.path);
      const from = known ? getComputedStyle(element).transform : undefined;
      for (const running of element.getAnimations()) running.cancel();
      element.style.transform = to;
      placed.current.add(tile.path);
      if (!animate) return;
      if (!known) {
        element.animate(
          [
            { opacity: 0, transform: `${to} scale(0.6)` },
            { opacity: 1, transform: to },
          ],
          { duration: 380, delay: Math.min(index * 8, 700), easing: EASE, fill: 'backwards' },
        );
      } else if (from && from !== 'none' && from !== to) {
        element.animate([{ transform: from }, { transform: to }], {
          duration: modeChanged ? FOLD_MS : RELAYOUT_MS,
          delay: modeChanged && folded ? (delayOf.get(index) ?? 0) : 0,
          easing: EASE,
          fill: 'both',
        });
      }
    });
  }, [tiles, folded, width, groups.length]);

  // The counter climbs as each pile lands, and drains when the roll is unfolded.
  useEffect(() => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
    if (!folded) {
      setLanded(0);
      return;
    }
    if (reducedMotion()) {
      setLanded(named);
      return;
    }
    piles.slice(0, named).forEach((_, order) => {
      timers.current.push(
        window.setTimeout(() => setLanded(order + 1), FOLD_MS + order * PILE_STAGGER_MS),
      );
    });
    return () => {
      for (const timer of timers.current) clearTimeout(timer);
    };
  }, [folded, named]);

  useLayoutEffect(() => {
    // Bring the roll to the top of the screen once, so the fold is what the visitor sees.
    const element = root.current?.closest('.roll');
    if (!element) return;
    const top = element.getBoundingClientRect().top;
    if (Math.abs(top - 24) > 8) {
      window.scrollTo({
        top: window.scrollY + top - 24,
        behavior: reducedMotion() ? 'auto' : 'smooth',
      });
    }
  }, []);

  useEffect(() => {
    if (!firstRun.current || tiles.length === 0 || !ready || reducedMotion()) return;
    firstRun.current = false;
    const timer = setTimeout(() => setFolded(true), FOLD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [tiles.length > 0, ready]);

  const hovered = readout === null ? undefined : groups[readout];
  const hoveredFrames = readout === null ? 0 : members(readout).length;
  // Both layouts' taller height is reserved, so nothing grows or spills while tiles are in flight.
  const stageHeight = Math.max(bars?.height ?? 0, strip?.height ?? 0);
  const baselines = [
    ...new Set(
      [...(bars?.columns ?? []), ...(bars?.none ? [bars.none] : [])].map((c) => c.baseline),
    ),
  ];
  // A pile's labels appear once its tiles have landed, never under tiles still in flight.
  const landDelay = (order: number) => order * PILE_STAGGER_MS + FOLD_MS;
  const orderOf = new Map(piles.map((pile, order) => [pile.tiles[0], order]));
  const quietColumns = (bars?.columns ?? []).filter((column) => column.quiet);
  const quietFirst = quietColumns[0];
  const quietLast = quietColumns
    .filter((column) => column.baseline === quietFirst?.baseline)
    .at(-1);
  const interactive = folded;
  // Only the pile that landed last is marked in the signal colour; the others keep a plain edge.
  const newest = landed > 0 ? piles[landed - 1]?.tiles[0] : undefined;
  const finale = folded && landed >= named;
  // The finale takes the tallest piles whose kept frame shows a whole animal, not a cut-off body.
  const faces = piles
    .flatMap((pile) => {
      const tile = tiles[pile.tiles[0] ?? -1];
      const info = groups[pile.group];
      return tile?.focus && info && !pile.quiet && wholeBody(tile.focus) ? [{ tile, info }] : [];
    })
    .slice(0, FACE_COUNT)
    .map((face, order) => ({ ...face, order }));

  return (
    <div class="roll" data-folded={folded}>
      <h2 class="roll-title">
        <span class="vh">
          {count.format(frames)} {frames === 1 ? 'frame' : 'frames'}, folded into{' '}
          {count.format(named)} species.
        </span>
        <span aria-hidden="true">
          <span class="count">{count.format(frames)}</span> {frames === 1 ? 'frame' : 'frames'}
          <span class="fold-part">
            <span class="fold-lead">folded into </span>
            <span class="count count-species">{count.format(landed)}</span> species.
          </span>
        </span>
      </h2>
      <div class="faces" data-open={folded}>
        <ol class="faces-row">
          {faces.map(({ tile, info, order }) => {
            const src =
              originalURL?.(tile.path) ?? photoURL?.(tile.path) ?? thumbnailURL?.(tile.path);
            if (!src || !tile.focus) return null;
            return (
              <li
                key={tile.path}
                class={folded ? 'face in' : 'face'}
                style={{ transitionDelay: `${order * FACE_STAGGER_MS}ms` }}
              >
                <Portrait src={src} box={tile.focus} label={`${info.name}, close up`} />
                <p class="face-name">
                  <span class="face-count">×{count.format(info.detections)}</span>{' '}
                  <span class="cap">{info.name}</span>
                </p>
              </li>
            );
          })}
        </ol>
      </div>
      <div class="plate-stage" ref={root} style={{ height: `${stageHeight}px` }}>
        <ul class="plate-tiles">
          {tiles.map((tile, index) => {
            const kept = tile.rank !== undefined;
            const source = sourceOf(tile);
            const order = orderOf.get(index);
            const natural = naturals[tile.path];
            const tiny =
              kept &&
              tile.focus !== undefined &&
              natural !== undefined &&
              Math.max(tile.focus[2] * natural[0], tile.focus[3] * natural[1]) < TINY_SUBJECT_PX;
            return (
              <li
                key={tile.path}
                class={['tile', kept && !tiny ? 'is-kept' : '', index === newest ? 'is-newest' : '']
                  .join(' ')
                  .trim()}
                ref={(element) => {
                  // An inline ref is re-run on every render with null first; `placed` must survive that.
                  if (element) items.current.set(tile.path, element);
                }}
              >
                {source && (
                  <img
                    src={source}
                    alt=""
                    decoding="async"
                    onError={() => settle(tile.path)}
                    onLoad={(event) => {
                      if (!kept) return;
                      settle(tile.path);
                      const { naturalWidth, naturalHeight } = event.currentTarget;
                      setNaturals((known) =>
                        known[tile.path]?.[0] === naturalWidth
                          ? known
                          : { ...known, [tile.path]: [naturalWidth, naturalHeight] },
                      );
                    }}
                    style={{
                      transform: folded && tile.focus && !tiny ? zoomTransform(tile.focus) : 'none',
                      transitionDelay: `${(order ?? 0) * PILE_STAGGER_MS + ZOOM_MS * 0.7}ms`,
                    }}
                  />
                )}
                {!source && <span class="tile-missing">Photo unavailable</span>}
                {tiny && tile.focus && (
                  <span
                    class="tile-box"
                    style={{
                      left: `${tile.focus[0] * 100}%`,
                      top: `${tile.focus[1] * 100}%`,
                      width: `${tile.focus[2] * 100}%`,
                      height: `${tile.focus[3] * 100}%`,
                    }}
                  />
                )}
                <span class="tile-frame">{String(index + 1).padStart(2, '0')}</span>
              </li>
            );
          })}
        </ul>
        {folded &&
          baselines.map((baseline) => (
            <i
              key={baseline}
              class="baseline"
              style={{ top: `${baseline}px`, left: `${metrics.pad}px`, right: `${metrics.pad}px` }}
            />
          ))}
        {(folded ? (bars?.columns ?? []) : []).map((column, order) => {
          const pile = piles[order];
          const info = pile ? groups[pile.group] : undefined;
          if (!info || !pile) return null;
          const quiet = pile.quiet;
          return (
            <div key={info.rank}>
              {/* A count is written over a pile only when it says more than the one photo does. */}
              {info.detections > 1 && (
                <span
                  class={quiet ? 'pile-count is-quiet' : 'pile-count'}
                  aria-hidden="true"
                  style={{
                    left: `${column.x}px`,
                    top: `${column.top - 24}px`,
                    width: `${column.width}px`,
                    animationDelay: `${landDelay(order)}ms`,
                  }}
                >
                  ×{count.format(info.detections)}
                </span>
              )}
              <button
                type="button"
                class={quiet ? 'pile-name is-quiet' : 'pile-name'}
                title={info.name}
                style={{
                  left: `${column.x - 3}px`,
                  top: `${column.baseline + 8}px`,
                  width: `${column.width + 6}px`,
                  animationDelay: `${landDelay(order)}ms`,
                }}
                tabIndex={interactive ? 0 : -1}
                aria-hidden={!interactive}
                onMouseEnter={() => setReadout(pile.group)}
                onFocus={() => setReadout(pile.group)}
                onMouseLeave={() => setReadout(null)}
                onBlur={() => setReadout(null)}
                onClick={() => onSelect?.(info.rank)}
              >
                <span
                  lang="en"
                  class={
                    longWord(info.name, columnChars(metrics.tileWidth))
                      ? 'pile-name-text is-long'
                      : 'pile-name-text'
                  }
                >
                  {info.name}
                </span>
                <span class="vh">
                  , {count.format(info.detections)} independent{' '}
                  {info.detections === 1 ? 'detection' : 'detections'}, go to its entry
                </span>
              </button>
            </div>
          );
        })}
        {folded && quietFirst && quietLast && (
          <span
            class="quiet-label"
            style={{
              left: `${quietFirst.x}px`,
              top: `${quietFirst.baseline + metrics.nameHeight + 12}px`,
              width: `${quietLast.x + quietLast.width - quietFirst.x}px`,
            }}
          >
            not named to species: {count.format(quietDetections)}
          </span>
        )}
        {folded && bars?.none && (
          <span
            class="pile-name is-none"
            style={{
              left: `${bars.none.x}px`,
              top: `${bars.none.baseline + 8}px`,
              width: `${bars.none.width}px`,
            }}
            aria-hidden="true"
          >
            <span class="pile-name-text">no animal</span>
          </span>
        )}
      </div>
      {finale && originalsMissing && faces.length > 0 && (
        <p class="faces-note">
          {faces.some(({ tile }) => thumbnailURL?.(tile.path))
            ? "These close-ups come from small previews, because this diary's folder is not open."
            : 'This diary has no photos attached.'}{' '}
          <button type="button" class="text-button" onClick={onAddFolder}>
            Add the folder
          </button>
        </p>
      )}
      <div class="roll-foot">
        <button
          type="button"
          class="text-button"
          aria-pressed={folded}
          onClick={() => {
            firstRun.current = false;
            setFolded((value) => !value);
          }}
        >
          {folded ? 'Unfold the roll' : 'Fold into species'}
        </button>
        <p class="roll-sub" aria-live="polite">
          {hovered
            ? `${hovered.name} · ${count.format(hovered.detections)} independent ${hovered.detections === 1 ? 'detection' : 'detections'} · ${count.format(hoveredFrames)} ${hoveredFrames === 1 ? 'frame' : 'frames'}`
            : ''}
        </p>
      </div>
    </div>
  );
}
