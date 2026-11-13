import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { diarySpecies } from './Diary';
import {
  animalMatte,
  applyGrade,
  assignFragments,
  exposure,
  type Fragment,
  farthestRow,
  fragmentGrid,
  gradeFor,
  type JoinerVisit,
  joinerVisits,
  laidRect,
  type Rect,
  readable,
  ringGains,
  sessionEvents,
  sheetTallies,
  turnOf,
  type VisitName,
} from './joinerVisits';
import type { Light, Relight } from './relight';
import { cssVars } from './Tally';

const SAMPLE_PREDICTIONS = 'sample/predictions.json';
// The first frame on the card, an empty burst; tools/sample/depth_master.py writes its depth map.
const MASTER = 'sample/598acdb6-23d2-11e8-a6a3-ec086b02610b.jpg';
const DEPTH = 'sample/master-depth.png';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86_400_000;

const STEP_MS = 1250;
const FIRST_FLASH_MS = 1200;
const FLASH_RISE_S = 0.05;
const FLASH_FALL_S = 0.35;
const BLOOM_S = 0.35;
const SCRUB_FLASH_GAP_MS = 140;
// The infrared lamps sit just above the lens, so the few shadows the flash casts fall below things.
const FLASH: Omit<Light, 'power'> = { x: 0.5, y: 0.3, z: 0.6 };
const TORCH_HEIGHT = 0.2;
// Before the first flash the frame shows as a faint infrared still, after a beat of true black.
const STILL = 0.01;
const STILL_DELAY_MS = 200;
const STILL_RISE_MS = 500;
// With no animal to aim at, the lamps light the path in the lower middle of the frame.
const DEFAULT_AIM = [0.5, 0.66] as const;
// The horizon is searched for in this band of the frame, between the data strip and the near ground.
const HORIZON_BAND = [0.1, 0.6] as const;
// Per frame, how far the daylight sweep travels: about two and a half seconds from lens to far bank.
const DAY_STEP = 1 / 150;
const LAYER_WIDTH = 1280;
const EDGE_PX = 1;
const PRINT_EDGE = 'rgb(226 208 176)';
const PRINT_MEAN = 0.36;
const PRINT_LIFT_MAX = 2;
const GRID_COLS = 9;
const GRID_ROWS = 6;
const FRAGMENTS_PER_PHOTO = 6;
const PROBE_WIDTH = 96;
const PROBE_PRINT = 24;
// Below this mean luminance a spot in a photo is too dark to give the joiner any ground; above
// the second it is blown out by the sun and shows no ground either.
// How far past a newer animal's edge an older one under it fades to ground, in layer pixels.
const APART_PX = 20;
const FRAGMENT_DARK = 0.08;
const FRAGMENT_BLOWN = 0.7;
// A spot where more than this share is clipped holds something too near the flash, not ground.
const FRAGMENT_CLIP = 0.85;
const FRAGMENT_CLIPPED = 0.1;

type Sample = {
  visits: JoinerVisit[];
  frames: number;
  spanDays: number;
};

/**
 * One print laid on the frame: a fragment of ground, or a visit's animal at its box. `art` is the
 * print graded to the master's light at the layer's scale; `soft` is the animal alone, cut from its
 * ground, as it shows at night.
 */
type Piece = Fragment & {
  path: string;
  burst: number;
  visit: number | null;
  /** Where an animal's print lies by day, laid by hand; ground lies where it was cut. */
  laid?: Rect;
  art?: HTMLCanvasElement;
  soft?: HTMLCanvasElement;
  /** The graded print as an image URL, for the page to lay when there is no WebGL to draw it. */
  still?: string;
};

const pad = (value: number) => String(value).padStart(2, '0');
const no = (value: number) => pad(value);

/** Camera wall clock, encoded as UTC by the diary, printed the way the camera burns it in. */
function stamp(ms: number): string {
  const d = new Date(ms);
  const hour = d.getUTCHours() % 12 || 12;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${hour}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCHours() < 12 ? 'AM' : 'PM'}`;
}

function day(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function shortDay(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]}`;
}

async function loadSample(base: string): Promise<Sample | undefined> {
  const response = await fetch(new URL(SAMPLE_PREDICTIONS, base));
  if (!response.ok) return undefined;
  const events = sessionEvents(await response.text());
  if (!events?.length) return undefined;
  const cards = diarySpecies(events);
  const times = events.flatMap(({ photos }) => photos.map(({ time }) => time.wallClockMs));
  return {
    visits: joinerVisits(events, cards),
    frames: times.length,
    spanDays: Math.round((Math.max(...times) - Math.min(...times)) / DAY_MS),
  };
}

function image(url: string): Promise<HTMLImageElement> {
  const element = new Image();
  element.src = url;
  return element.decode().then(() => element);
}

/** Luminance of `rect` of a photo, sampled `width` by `height`. */
function luminance(
  probe: CanvasRenderingContext2D,
  photo: HTMLImageElement,
  [x, y, w, h]: Rect,
  width: number,
  height: number,
): Float32Array {
  probe.canvas.width = width;
  probe.canvas.height = height;
  probe.drawImage(
    photo,
    x * photo.naturalWidth,
    y * photo.naturalHeight,
    w * photo.naturalWidth,
    h * photo.naturalHeight,
    0,
    0,
    width,
    height,
  );
  const rgba = probe.getImageData(0, 0, width, height).data;
  const values = new Float32Array(width * height);
  for (let i = 0; i < values.length; i++) {
    values[i] =
      (0.2126 * (rgba[i * 4] ?? 0) +
        0.7152 * (rgba[i * 4 + 1] ?? 0) +
        0.0722 * (rgba[i * 4 + 2] ?? 0)) /
      255;
  }
  return values;
}

/** The mean colour of a photo, each channel in [0, 1]. */
function meanColour(
  probe: CanvasRenderingContext2D,
  photo: HTMLImageElement,
): [number, number, number] {
  probe.canvas.width = PROBE_WIDTH;
  probe.canvas.height = PROBE_WIDTH;
  probe.drawImage(photo, 0, 0, PROBE_WIDTH, PROBE_WIDTH);
  const rgba = probe.getImageData(0, 0, PROBE_WIDTH, PROBE_WIDTH).data;
  const sum = [0, 0, 0];
  for (let i = 0; i < rgba.length; i += 4) {
    for (let c = 0; c < 3; c++) sum[c] = (sum[c] ?? 0) + (rgba[i + c] ?? 0);
  }
  const n = (rgba.length / 4) * 255;
  return [(sum[0] ?? 0) / n, (sum[1] ?? 0) / n, (sum[2] ?? 0) / n];
}

/** The colour of a photo's white: each channel's 97th percentile, below the clipped highlights. */
function whiteColour(
  probe: CanvasRenderingContext2D,
  photo: HTMLImageElement,
): [number, number, number] {
  probe.canvas.width = PROBE_WIDTH;
  probe.canvas.height = PROBE_WIDTH;
  probe.drawImage(photo, 0, 0, PROBE_WIDTH, PROBE_WIDTH);
  const rgba = probe.getImageData(0, 0, PROBE_WIDTH, PROBE_WIDTH).data;
  const at = (c: number) =>
    (Float32Array.from({ length: rgba.length / 4 }, (_, i) => rgba[i * 4 + c] ?? 0).sort()[
      Math.floor((rgba.length / 4) * 0.97)
    ] ?? 255) / 255;
  return [at(0), at(1), at(2)];
}

/** A canvas holding `rect` of `source`, at the source's scale. */
function cut(source: CanvasImageSource & { width: number; height: number }, [x, y, w, h]: Rect) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * source.width));
  canvas.height = Math.max(1, Math.round(h * source.height));
  canvas
    .getContext('2d')
    ?.drawImage(
      source,
      x * source.width,
      y * source.height,
      w * source.width,
      h * source.height,
      0,
      0,
      canvas.width,
      canvas.height,
    );
  return canvas;
}

/** The print's animal alone, cut from its ground by where it differs from the rest of its burst. */
function matte(
  art: HTMLCanvasElement,
  photo: HTMLImageElement,
  frames: readonly HTMLImageElement[],
  master: HTMLImageElement,
  rect: Rect,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = art.width;
  canvas.height = art.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return canvas;
  // Measured on the photos as shot, so the print and its burst are in the same light.
  const read = (source: HTMLImageElement) => {
    const [x, y, w, h] = rect;
    const [sw, sh] = [source.naturalWidth, source.naturalHeight];
    context.drawImage(source, x * sw, y * sh, w * sw, h * sh, 0, 0, art.width, art.height);
    return context.getImageData(0, 0, art.width, art.height).data;
  };
  const alpha = animalMatte(read(photo), frames.map(read), art.width, art.height);
  const print = art
    .getContext('2d', { willReadFrequently: true })
    ?.getImageData(0, 0, art.width, art.height);
  if (!print) return canvas;
  const gains = ringGains(print.data, read(master), art.width, art.height);
  for (let i = 0; i < alpha.length; i++) {
    for (let c = 0; c < 3; c++)
      print.data[i * 4 + c] = (print.data[i * 4 + c] ?? 0) * (gains[c] ?? 1);
    print.data[i * 4 + 3] = (alpha[i] ?? 0) * 255;
  }
  context.putImageData(print, 0, 0);
  return canvas;
}

/**
 * Lays out the joiner: fragments of ground cut from the bursts whose photo shows that spot best, and
 * a print for every visit whose crop shows an animal. Each piece lands with its own burst, graded to
 * the master's light so the finished picture reads as one place on one day.
 */
async function planPieces(
  visits: readonly JoinerVisit[],
  photos: Map<string, HTMLImageElement>,
  master: HTMLImageElement,
  horizon: number,
  layerHeight: number,
): Promise<Piece[]> {
  const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!probe) return [];
  const grid = fragmentGrid(GRID_COLS, GRID_ROWS, horizon);
  const height = Math.round(PROBE_WIDTH * 0.73);
  const reference = meanColour(probe, master);
  const daylight = whiteColour(probe, master);
  const scores = visits.map((visit) => {
    const photo = photos.get(visit.photo.path);
    if (!photo) return grid.map(() => 0);
    // A photo that has to be toned to match, an infrared night above all, gives no ground: where
    // only such photos reach, the master frame's own daylight shows through.
    const colour = gradeFor(meanColour(probe, photo), reference, daylight).keep;
    const values = luminance(probe, photo, [0, 0, 1, 1], PROBE_WIDTH, height);
    return grid.map(({ rect: [x, y, w, h] }) => {
      const inside: number[] = [];
      for (let row = Math.floor(y * height); row < Math.ceil((y + h) * height); row++) {
        for (let col = Math.floor(x * PROBE_WIDTH); col < Math.ceil((x + w) * PROBE_WIDTH); col++) {
          inside.push(values[row * PROBE_WIDTH + col] ?? 0);
        }
      }
      const { mean, spread } = exposure(inside);
      const clipped = inside.filter((value) => value > FRAGMENT_CLIP).length / inside.length;
      return mean < FRAGMENT_DARK || mean > FRAGMENT_BLOWN || clipped > FRAGMENT_CLIPPED
        ? 0
        : colour * (spread + 0.5 * Math.min(mean, 0.55));
    });
  });
  const ground: Piece[] = assignFragments(scores, FRAGMENTS_PER_PHOTO).flatMap((burst, cell) => {
    const fragment = grid[cell];
    const visit = visits[burst];
    return fragment && visit && (scores[burst]?.[cell] ?? 0) > 0
      ? [{ ...fragment, path: visit.photo.path, burst, visit: null }]
      : [];
  });
  const prints: Piece[] = visits.flatMap((visit, index) => {
    const photo = photos.get(visit.photo.path);
    if (!visit.window || !photo) return [];
    if (!readable(luminance(probe, photo, visit.window, PROBE_PRINT, PROBE_PRINT))) return [];
    return [
      {
        rect: visit.window,
        laid: laidRect(visit.window, index),
        turnDeg: turnOf(100 + index),
        path: visit.photo.path,
        burst: index,
        visit: index,
      },
    ];
  });
  const pieces = [...ground, ...prints];
  // One photo graded at a time, at the layer's scale, so only its pieces are kept.
  const graded = document.createElement('canvas');
  graded.width = LAYER_WIDTH;
  graded.height = layerHeight;
  const context = graded.getContext('2d', { willReadFrequently: true });
  if (!context) return pieces;
  for (const path of new Set(pieces.map((piece) => piece.path))) {
    const photo = photos.get(path);
    if (!photo) continue;
    // One photo per task, so a click or a frame of the flash is never kept waiting on the grading.
    await new Promise((resolve) => setTimeout(resolve));
    context.drawImage(photo, 0, 0, graded.width, graded.height);
    const pixels = context.getImageData(0, 0, graded.width, graded.height);
    applyGrade(pixels.data, gradeFor(meanColour(probe, photo), reference, daylight));
    context.putImageData(pixels, 0, 0);
    for (const piece of pieces) {
      if (piece.path !== path) continue;
      piece.art = cut(graded, piece.rect);
      const visit = piece.visit === null ? undefined : visits[piece.visit];
      if (!visit) continue;
      liftDark(piece.art);
      const frames = visit.frames.flatMap((other) => {
        const frame = other === path ? undefined : photos.get(other);
        return frame ? [frame] : [];
      });
      piece.soft = matte(piece.art, photo, frames, master, piece.rect);
    }
  }
  return pieces;
}

/** A dark print is brightened toward PRINT_MEAN, at most PRINT_LIFT_MAX times, so it never reads as a hole. */
function liftDark(art: HTMLCanvasElement) {
  const context = art.getContext('2d', { willReadFrequently: true });
  if (!context) return;
  const rgba = context.getImageData(0, 0, art.width, art.height).data;
  let sum = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    sum += 0.2126 * (rgba[i] ?? 0) + 0.7152 * (rgba[i + 1] ?? 0) + 0.0722 * (rgba[i + 2] ?? 0);
  }
  const mean = sum / (rgba.length / 4) / 255;
  const lift = Math.min(PRINT_LIFT_MAX, PRINT_MEAN / Math.max(mean, 0.01));
  if (lift <= 1) return;
  context.filter = `brightness(${lift})`;
  context.drawImage(art, 0, 0);
  context.filter = 'none';
}

/** By day a piece is laid turned by hand, an animal's print with a bone border; by night only its animal. */
function drawPiece(context: CanvasRenderingContext2D, piece: Piece, night: boolean) {
  const { width, height } = context.canvas;
  const [x, y, w, h] = piece.rect;
  const [pw, ph] = [w * width, h * height];
  if (night) {
    if (!piece.soft) return;
    // Older animals fade to ground under and around a newer one, so two never fuse into one shape.
    context.save();
    context.globalCompositeOperation = 'destination-out';
    context.filter = `blur(${APART_PX}px)`;
    for (let pass = 0; pass < 2; pass++) {
      context.drawImage(piece.soft, x * width, y * height, pw, ph);
    }
    context.restore();
    context.drawImage(piece.soft, x * width, y * height, pw, ph);
    return;
  }
  if (!piece.art) return;
  const [lx, ly, lw, lh] = piece.laid ?? piece.rect;
  const [dw, dh] = [lw * width, lh * height];
  context.save();
  context.translate((lx + lw / 2) * width, (ly + lh / 2) * height);
  context.rotate((piece.turnDeg * Math.PI) / 180);
  // Ground meets ground edge to edge; only an animal's print has an edge, a thin warm one.
  if (piece.visit !== null) {
    context.fillStyle = PRINT_EDGE;
    context.fillRect(-dw / 2 - EDGE_PX, -dh / 2 - EDGE_PX, dw + 2 * EDGE_PX, dh + 2 * EDGE_PX);
  }
  context.drawImage(piece.art, -dw / 2, -dh / 2, dw, dh);
  context.restore();
}

/** A common name set on its own line, capitalised as a field guide sets it. */
function capital(name: string | null): string {
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : 'No label';
}

function nameText({ name, rank }: VisitName): string {
  return `${capital(name)}${rank === 'species' ? '' : `, named only to ${rank ?? 'animal'}`}`;
}

function visitLabel(visit: JoinerVisit): string {
  if (visit.number === null) return `${day(visit.timeMs)}, the camera fired and kept no animal`;
  return `No. ${no(visit.number)}, ${day(visit.timeMs)}, ${[visit, ...visit.also].map(nameText).join(' and ')}`;
}

/** A name as the sheet writes it: the binomial in italic, or an empty rule and how far it reached. */
function SheetName({ name, scientificName, rank }: VisitName) {
  return (
    <span class="name">
      <span class="common">{capital(name)}</span>
      {rank === 'species' ? (
        <i class="latin">{scientificName}</i>
      ) : (
        <span class="blank">
          <span class="rule" />
          {rank && <span class="reach">to {rank}</span>}
        </span>
      )}
    </span>
  );
}

/**
 * The sample card as one picture: the camera's empty frame in the dark, and every visit of the year
 * cut at the detector's box and put back where the camera saw it, each landing on its own flash.
 */
export function Joiner({ base }: { base: string }) {
  const [sample, setSample] = useState<Sample>();
  const [cursor, setCursor] = useState(-1);
  const [focus, setFocus] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [lit, setLit] = useState(false);
  const [watched, setWatched] = useState(true);
  const [gl, setGl] = useState<'pending' | 'on' | 'off'>('pending');
  const [pieces, setPieces] = useState<Piece[]>([]);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const relight = useRef<Relight | null>(null);
  const photos = useRef(new Map<string, HTMLImageElement>());
  const layer = useRef<HTMLCanvasElement | null>(null);
  const motion = useRef({
    flashAt: Number.NEGATIVE_INFINITY,
    torch: { x: 0.5, y: 0.6, power: 0, target: 0, tx: 0.5, ty: 0.6 },
    frame: 0,
    visible: true,
    day: 0,
    bornAt: 0,
  });
  // The frame loop runs outside renders, so it reads the latest view from here.
  const view = useRef({ front: undefined as JoinerVisit | undefined, done: false });
  const reduced = useMemo(
    () =>
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  useEffect(() => {
    loadSample(base)
      .then((loaded) => {
        if (!loaded) return;
        setSample(loaded);
        if (reduced) setCursor(loaded.visits.length - 1);
      })
      .catch(() => undefined);
  }, [base, reduced]);

  const visits = sample?.visits ?? [];
  const current = cursor >= 0 ? visits[cursor] : undefined;
  const shown = focus !== null ? visits[focus] : current;
  const span = visits.length
    ? ([visits[0]?.timeMs ?? 0, (visits.at(-1)?.timeMs ?? 0) + 1] as const)
    : ([0, 1] as const);
  const at = (ms: number) => (ms - span[0]) / (span[1] - span[0]);

  // The renderer arrives after first paint; until then the page shows the still frame in the DOM.
  useEffect(() => {
    if (!sample || !canvas.current) return;
    let cancelled = false;
    const target = canvas.current;
    const narrow = matchMedia('(max-width: 700px), (pointer: coarse)').matches;
    Promise.all([
      import('./relight'),
      image(new URL(MASTER, base).href),
      image(new URL(DEPTH, base).href),
      // Each print's whole burst, which its matte is measured against.
      ...[
        ...new Set(
          sample.visits.flatMap((visit) => (visit.window ? visit.frames : [visit.photo.path])),
        ),
      ].map((path) =>
        image(new URL(path, base).href).then((photo) => photos.current.set(path, photo)),
      ),
    ])
      .then(async ([{ createRelight, depthPixels }, master, depth]) => {
        if (cancelled) return;
        const layerHeight = Math.round((LAYER_WIDTH * master.naturalHeight) / master.naturalWidth);
        const horizon = farthestRow(depthPixels(depth), depth.naturalWidth, ...HORIZON_BAND);
        const planned = await planPieces(
          sample.visits,
          photos.current,
          master,
          horizon,
          layerHeight,
        );
        if (cancelled) return;
        const created = createRelight(target, master, depth, narrow ? 1 : 2);
        if (!created) {
          for (const piece of planned) {
            if (piece.art) piece.still = piece.art.toDataURL('image/jpeg', 0.88);
          }
          setPieces(planned);
          setGl('off');
          return;
        }
        setPieces(planned);
        layer.current = document.createElement('canvas');
        layer.current.width = LAYER_WIDTH;
        layer.current.height = layerHeight;
        relight.current = created;
        motion.current.bornAt = performance.now();
        setGl('on');
      })
      .catch(() => {
        if (!cancelled) setGl('off');
      });
    return () => {
      cancelled = true;
      relight.current?.dispose();
      relight.current = null;
    };
  }, [sample, base]);

  const shownIndex = focus ?? cursor;
  const printed = new Set(pieces.flatMap(({ visit }) => (visit === null ? [] : [visit])));
  const front = shown && printed.has(shownIndex) ? shown : undefined;
  const done = reduced || (!playing && cursor === visits.length - 1);
  view.current = { front, done };
  // Ground first in the order it was laid, then the animals, larger under smaller, the front last.
  const laid = pieces
    .filter((piece) => piece.burst <= cursor)
    .toSorted(
      (a, b) =>
        Number(a.visit !== null) - Number(b.visit !== null) ||
        Number(a.visit === shownIndex) - Number(b.visit === shownIndex) ||
        (a.visit === null ? a.burst - b.burst : b.rect[2] * b.rect[3] - a.rect[2] * a.rect[3]),
    );

  // Redraw the layer of prints whenever the set, the visit in front, or night and day change.
  useEffect(() => {
    const target = layer.current;
    const context = target?.getContext('2d');
    if (!target || !context || gl !== 'on') return;
    context.clearRect(0, 0, target.width, target.height);
    // At night the animals stack in the order they came, the one in front last.
    const order = done
      ? laid
      : laid.toSorted(
          (a, b) =>
            Number(a.visit === shownIndex) - Number(b.visit === shownIndex) || a.burst - b.burst,
        );
    for (const piece of order) drawPiece(context, piece, !done);
    relight.current?.setCrops(target);
    paint();
  }, [gl, cursor, shownIndex, pieces, done]);

  function paint() {
    const m = motion.current;
    if (m.frame || !relight.current) return;
    m.frame = requestAnimationFrame(tick);
  }

  function tick(now: number) {
    const m = motion.current;
    m.frame = 0;
    const gfx = relight.current;
    if (!gfx || !m.visible) return;
    const t = (now - m.flashAt) / 1000;
    const envelope =
      t < 0
        ? 0
        : t < FLASH_RISE_S
          ? t / FLASH_RISE_S
          : Math.exp(-(t - FLASH_RISE_S) / FLASH_FALL_S);
    const torch = m.torch;
    torch.power += (torch.target - torch.power) * 0.16;
    torch.x += (torch.tx - torch.x) * 0.3;
    torch.y += (torch.ty - torch.y) * 0.3;
    const { front: lead, done: finished } = view.current;
    const day = finished ? 1 : 0;
    m.day = reduced ? day : Math.min(m.day + DAY_STEP, Math.max(m.day - DAY_STEP, day));
    const rise = Math.min(1, Math.max(0, (now - m.bornAt - STILL_DELAY_MS) / STILL_RISE_MS));
    const box = lead?.window;
    gfx.draw({
      flash: { ...FLASH, power: reduced ? 0 : envelope },
      torch: { x: torch.x, y: torch.y, z: TORCH_HEIGHT, power: torch.power },
      aim: box ? [box[0] + box[2] / 2, box[1] + box[3] / 2] : DEFAULT_AIM,
      ambient: STILL * rise * rise * (3 - 2 * rise),
      activeRect: box ?? [0, 0, 0, 0],
      active: lead && !reduced ? envelope : 0,
      bloom: reduced ? 0 : Math.max(0, 1 - t / BLOOM_S) ** 2,
      day: m.day,
    });
    const settling =
      rise < 1 ||
      envelope > 0.003 ||
      Math.abs(day - m.day) > 0.003 ||
      Math.abs(torch.target - torch.power) > 0.003 ||
      Math.hypot(torch.tx - torch.x, torch.ty - torch.y) > 0.001;
    setLit(envelope > 0.2);
    if (settling) m.frame = requestAnimationFrame(tick);
  }

  function fire() {
    const m = motion.current;
    const now = performance.now();
    if (now - m.flashAt < SCRUB_FLASH_GAP_MS) return;
    m.flashAt = reduced ? Number.NEGATIVE_INFINITY : now;
    paint();
  }

  function goTo(index: number) {
    const next = Math.max(-1, Math.min(visits.length - 1, index));
    if (next === cursor) return;
    setCursor(next);
    setFocus(null);
    if (next >= 0) fire();
  }

  // Autoplay: one burst per step, from the dark frame to the last visit, once.
  useEffect(() => {
    if (!sample || reduced || gl === 'pending') return;
    setPlaying(true);
  }, [sample, gl, reduced]);

  // The year waits while nobody can see it: the frame scrolled away or the tab in the background.
  useEffect(() => {
    if (!playing || !watched) return;
    if (cursor >= visits.length - 1) {
      setPlaying(false);
      return;
    }
    // The year opens on the first burst with an animal to show, not on bare ground.
    const first = Math.max(
      0,
      visits.findIndex((_, index) => printed.has(index)),
    );
    const timer = setTimeout(
      () => goTo(cursor < 0 ? first : cursor + 1),
      cursor < 0 ? FIRST_FLASH_MS : STEP_MS,
    );
    return () => clearTimeout(timer);
  }, [playing, cursor, watched]);

  useEffect(() => {
    paint();
  }, [playing]);

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const update = () => {
      const m = motion.current;
      setWatched(m.visible && !document.hidden);
      if (m.visible) paint();
    };
    const observer = new IntersectionObserver(([entry]) => {
      motion.current.visible = Boolean(entry?.isIntersecting);
      update();
    });
    observer.observe(element);
    document.addEventListener('visibilitychange', update);
    const resize = new ResizeObserver(() => {
      relight.current?.resize();
      paint();
    });
    resize.observe(element);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', update);
      resize.disconnect();
      cancelAnimationFrame(motion.current.frame);
    };
  }, [sample]);

  function select(index: number, flash: boolean) {
    setPlaying(false);
    if (index > cursor) setCursor(index);
    setFocus(index);
    if (flash) fire();
    else paint();
  }

  function pointer(event: PointerEvent) {
    const box = canvas.current?.getBoundingClientRect();
    if (!box) return;
    const torch = motion.current.torch;
    torch.tx = (event.clientX - box.left) / box.width;
    torch.ty = (event.clientY - box.top) / box.height;
    torch.target = 1;
    paint();
  }

  function scrub(event: PointerEvent) {
    const track = event.currentTarget as HTMLElement;
    const box = track.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
    const ms = span[0] + fraction * (span[1] - span[0]);
    setPlaying(false);
    goTo(visits.findLastIndex((visit) => visit.timeMs <= ms));
  }

  function key(event: KeyboardEvent) {
    const moves: Record<string, number> = {
      ArrowRight: shownIndex + 1,
      ArrowUp: shownIndex + 1,
      ArrowLeft: shownIndex - 1,
      ArrowDown: shownIndex - 1,
      Home: 0,
      End: visits.length - 1,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setPlaying(false);
    goTo(next);
  }

  if (!sample) {
    return (
      <figure class="joiner" aria-hidden="true">
        <div class="joiner-stage" />
      </figure>
    );
  }

  const counts = sheetTallies(visits.slice(0, cursor + 1));
  const months: { left: number; label: string }[] = [];
  const first = new Date(span[0]);
  for (
    let m = Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1);
    m < span[1];
    m = Date.UTC(new Date(m).getUTCFullYear(), new Date(m).getUTCMonth() + 1, 1)
  ) {
    const d = new Date(m);
    months.push({
      left: at(m),
      label:
        d.getUTCMonth() === 0
          ? `${MONTHS[0]} ${d.getUTCFullYear()}`
          : (MONTHS[d.getUTCMonth()] ?? ''),
    });
  }
  const osd = shown ?? visits[0];

  return (
    <>
      <figure class="joiner">
        <h1 class="claim">
          <strong>{sample.spanDays} days</strong> at one trail camera, in one picture.
        </h1>
        <div
          ref={stage}
          class="joiner-stage"
          data-gl={gl}
          data-lit={lit}
          data-playing={playing}
          data-day={done}
          onPointerMove={pointer}
          onPointerLeave={() => {
            motion.current.torch.target = 0;
            paint();
          }}
        >
          <img class="master" src={new URL(MASTER, base).href} alt="" />
          <canvas ref={canvas} />
          {osd && (
            <p class="osd" aria-hidden="true">
              <span>{stamp(osd.photo.time.wallClockMs)}</span>
              <span>
                M {osd.frameIndex + 1}/{osd.burstSize}
              </span>
              <span class="ir">IR</span>
            </p>
          )}
          <ul class="windows" aria-label="Visits on the frame">
            {laid.map((piece) => {
              const visit = piece.visit === null ? undefined : visits[piece.visit];
              const shown = done && piece.laid ? piece.laid : piece.rect;
              const place = cssVars({
                left: `${shown[0] * 100}%`,
                top: `${shown[1] * 100}%`,
                width: `${shown[2] * 100}%`,
                height: `${shown[3] * 100}%`,
                '--photo': `url("${new URL(piece.path, base).href}")`,
                '--x': piece.rect[0],
                '--y': piece.rect[1],
                '--w': piece.rect[2],
                '--h': piece.rect[3],
                '--turn': `${piece.turnDeg}deg`,
                ...(piece.still ? { '--print': `url("${piece.still}")` } : {}),
              });
              if (!visit || piece.visit === null) {
                return (
                  <li
                    key={`${piece.path} ${piece.rect[0]} ${piece.rect[1]}`}
                    class="ground"
                    style={place}
                    aria-hidden="true"
                  />
                );
              }
              const index = piece.visit;
              return (
                <li key={piece.path}>
                  <button
                    type="button"
                    class="window"
                    aria-label={visitLabel(visit)}
                    data-front={visit === front}
                    style={place}
                    onClick={() => select(index, true)}
                    onPointerEnter={() => select(index, false)}
                    onFocus={() => select(index, false)}
                  >
                    <span class="tag">{capital(visit.name)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div class="joiner-year">
          <div
            class="track"
            role="slider"
            tabIndex={0}
            aria-label="Bursts on the card, in order"
            aria-valuemin={0}
            aria-valuemax={visits.length}
            aria-valuenow={shownIndex + 1}
            aria-valuetext={shown ? visitLabel(shown) : 'Before the first burst'}
            onKeyDown={key}
            onPointerDown={(event) => {
              (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
              scrub(event);
            }}
            onPointerMove={(event) => {
              if ((event.currentTarget as HTMLElement).hasPointerCapture(event.pointerId))
                scrub(event);
            }}
          >
            <span class="lit" style={cssVars({ '--p': current ? at(current.timeMs) : 0 })} />
            {visits.map((visit, index) => (
              <span
                key={visit.photo.path}
                class="tick"
                data-empty={visit.number === null}
                data-past={index <= cursor}
                style={cssVars({ '--p': at(visit.timeMs) })}
              />
            ))}
            {/* The head marks the burst on the frame, which a chosen row or print can bring back. */}
            {shown && <span class="head" style={cssVars({ '--p': at(shown.timeMs) })} />}
          </div>
          <ol class="months" aria-hidden="true">
            {months.map(({ left, label }) => (
              <li key={label} style={cssVars({ '--p': left })}>
                {label}
              </li>
            ))}
          </ol>
          {!reduced && (
            <button
              type="button"
              class="replay"
              disabled={playing}
              onClick={() => {
                setFocus(null);
                setCursor(-1);
                setPlaying(true);
              }}
            >
              Replay the year
            </button>
          )}
          {gl === 'on' && (
            <p class="lamp-cue">
              Move a pointer or a finger across the frame to light it with a lamp.
            </p>
          )}
        </div>
        <figcaption>
          <p>
            The camera never moves, so every visit on the sample card is cut from its own photo at
            the detector's box and put back where the camera saw it. Each burst fires the infrared
            flash again. These model predictions include mistaken labels and detections in empty
            frames. A blank species line means the species was not identified.
          </p>
        </figcaption>
      </figure>

      <section class="sheet" aria-label="Field sheet for the sample card">
        <header class="sheet-head">
          <p>
            <span class="caption">Station</span>Sample card
          </p>
          <p>
            <span class="caption">Frames</span>
            {sample.frames}
          </p>
          <p>
            <span class="caption">Bursts</span>
            {visits.length}
          </p>
          <p>
            <span class="caption">Days</span>
            {sample.spanDays}
          </p>
        </header>
        <ol class="entries">
          {visits.map((visit, index) => {
            // A row is written when its burst is read, so the sheet grows down the year.
            if (visit.number === null) return null;
            // Every row is ruled from the start and written in when its burst flashes.
            if (index > cursor) {
              return <li key={visit.photo.path} class="waiting" aria-hidden="true" />;
            }
            return (
              <li key={visit.photo.path} data-front={visit === front}>
                <button
                  type="button"
                  aria-label={visitLabel(visit)}
                  onClick={() => select(index, true)}
                  onPointerEnter={() => select(index, false)}
                  onFocus={() => select(index, false)}
                >
                  <span class="d">{shortDay(visit.timeMs)}</span>
                  <span class="det">
                    {[visit, ...visit.also].flatMap((named, order) => [
                      order > 0 ? ' and ' : '',
                      <SheetName key={named.name} {...named} />,
                    ])}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        <dl class="tallies">
          <div hidden={counts.named === 0}>
            <dt>Named to species</dt>
            <dd>{counts.named}</dd>
          </div>
          <div hidden={counts.broader === 0}>
            <dt>Stopped above species</dt>
            <dd>{counts.broader}</dd>
          </div>
          <div hidden={counts.empty === 0}>
            <dt>Bursts with no animal</dt>
            <dd>{counts.empty}</dd>
          </div>
        </dl>
      </section>
    </>
  );
}
