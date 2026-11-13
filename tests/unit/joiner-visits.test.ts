import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { diarySpecies } from '../../src/ui/Diary';
import {
  animalMatte,
  applyGrade,
  assignFragments,
  cutByEdge,
  determinedTo,
  exposure,
  farthestRow,
  fragmentGrid,
  gradeFor,
  joinerVisits,
  laidRect,
  readable,
  ringGains,
  sessionEvents,
  sheetTallies,
  visitWindow,
} from '../../src/ui/joinerVisits';
import { labelCounts } from '../../src/ui/SpeciesCard';

const events = sessionEvents(readFileSync('public/sample/predictions.json', 'utf8')) ?? [];
const cards = diarySpecies(events);
const visits = joinerVisits(events, cards);

test('the sample gives one visit per burst, numbering only the bursts that kept an animal', () => {
  expect(visits).toHaveLength(20);
  expect(visits.filter(({ number }) => number === null)).toHaveLength(3);
  expect(visits.flatMap(({ number }) => (number === null ? [] : [number]))).toEqual(
    Array.from({ length: 17 }, (_, index) => index + 1),
  );
  expect(visits.map(({ timeMs }) => timeMs)).toEqual(visits.map(({ timeMs }) => timeMs).toSorted());
});

test('a label that stops above species keeps its blank and says how far it got', () => {
  const ranks = visits.flatMap(({ number, name, rank }) => (number ? [`${name}: ${rank}`] : []));
  expect(ranks).toContain('bobcat: species');
  expect(ranks).toContain('rabbit and hare family: family');
  expect(ranks).toContain('mammal: class');
  expect(ranks).toContain('Unidentified animal: null');
  expect(visits.filter(({ rank }) => rank === 'species')).toHaveLength(12);
});

test('a window never fills the lens and always sits inside the frame', () => {
  for (const { window } of visits) {
    if (!window) continue;
    const [x, y, w, h] = window;
    expect(w * h).toBeLessThan(0.3 * 1.25 ** 2);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(x + w).toBeLessThanOrEqual(1);
    expect(y + h).toBeLessThanOrEqual(1);
  }
});

test('ranks read from the label path, and tiny boxes open to a readable window', () => {
  expect(determinedTo('id;mammalia;carnivora;canidae;canis;latrans;coyote')).toBe('species');
  expect(determinedTo('id;mammalia;lagomorpha;leporidae;;;rabbit and hare family')).toBe('family');
  expect(determinedTo('id;;;;;;animal')).toBeNull();
  expect(visitWindow([0.98, 0.5, 0.01, 0.01])).toEqual([0.94, 0.465, 0.06, 0.08]);
});

test('the finished sheet counts as the diary does: 8 named, 5 stopped above species, 3 empty', () => {
  expect(sheetTallies(visits)).toEqual({ ...labelCounts(cards), empty: 3 });
  expect(sheetTallies(visits)).toEqual({ named: 8, broader: 5, empty: 3 });
  const blanks = visits.flatMap((visit) =>
    visit.number === null ? [] : [visit, ...visit.also].filter(({ rank }) => rank !== 'species'),
  );
  expect(blanks).toHaveLength(5);
});

test('the sheet names every species the diary counted, including a second one in a burst', () => {
  const sheet = new Set(visits.flatMap((visit) => [visit, ...visit.also].map(({ name }) => name)));
  sheet.delete(null);
  expect([...sheet].toSorted()).toEqual(cards.map(({ name }) => name).toSorted());
  const mixed = visits.find(({ also }) => also.length > 0);
  expect([mixed?.name, ...(mixed?.also ?? []).map(({ name }) => name)]).toEqual([
    'coyote',
    'northern raccoon',
  ]);
});

test('an animal the frame cuts in two gets no print, and its burst keeps its number', () => {
  expect(cutByEdge([0.005, 0.4, 0.2, 0.2])).toBe(true);
  expect(cutByEdge([0.6, 0.5, 0.39, 0.48])).toBe(true);
  expect(cutByEdge([0.3, 0.4, 0.2, 0.2])).toBe(false);
  const cut = visits.filter(({ number, window }) => number !== null && window === null);
  expect(cut.map(({ number }) => number)).toEqual([6, 14, 17]);
});

test('the fragments cover the whole frame below the data strip and stay inside it', () => {
  const grid = fragmentGrid(6, 4, 0.29);
  expect(grid).toHaveLength(26);
  for (const { rect, turnDeg } of grid) {
    const [x, y, w, h] = rect;
    expect(Math.abs(turnDeg)).toBeLessThanOrEqual(2);
    expect(x).toBeGreaterThan(0);
    expect(y).toBeGreaterThan(0.03);
    expect(x + w).toBeLessThan(1);
    expect(y + h).toBeLessThan(0.975);
  }
  for (let u = 0.02; u < 0.98; u += 0.01) {
    for (let v = 0.05; v < 0.96; v += 0.01) {
      const covered = grid.some(
        ({ rect: [x, y, w, h] }) => u >= x && u <= x + w && v >= y && v <= y + h,
      );
      expect(covered, `${u.toFixed(2)}, ${v.toFixed(2)}`).toBe(true);
    }
  }
});

test('the first row of fragments ends on the horizon, and the next rows are laid like bricks', () => {
  const grid = fragmentGrid(6, 4, 0.29);
  const firstRow = grid.slice(0, 6);
  for (const { rect } of firstRow) expect(rect[1] + rect[3]).toBeCloseTo(0.298, 3);
  const lefts = (from: number, to: number) => grid.slice(from, to).map(({ rect }) => rect[0]);
  const seams = new Set(lefts(0, 6).map((x) => x.toFixed(2)));
  expect(lefts(6, 13).filter((x) => x > 0.05 && seams.has(x.toFixed(2)))).toEqual([]);
});

test('the horizon is the row whose depth is least, between the given bounds', () => {
  const width = 4;
  const rows = [0.9, 0.5, 0.2, 0.3, 0.6, 0.8, 0.95, 0.99, 1, 1];
  const depth = rows.flatMap((value) => [value, value + 0.01, value, 0.99]);
  expect(farthestRow(depth, width, 0.1, 0.6)).toBeCloseTo(0.2);
  expect(farthestRow(depth, width, 0.3, 0.6)).toBeCloseTo(0.3);
});

test('a grade keeps a photo near the reference in colour and tones one far from it', () => {
  const sand = [0.566, 0.522, 0.384] as const;
  const daylight = [0.922, 0.859, 0.71] as const;
  const same = gradeFor(sand, sand, daylight);
  expect(same.gamma).toBeCloseTo(1);
  expect(same.keep).toBe(1);
  for (const gain of same.tint) expect(gain).toBeCloseTo(1);
  expect(gradeFor([0.47, 0.432, 0.322], sand, daylight).keep).toBe(1);
  expect(gradeFor([0.684, 0.449, 0.402], sand, daylight).keep).toBe(0);
  // Each photo keeps its own white balance within a tenth, and meets the reference's brightness half way.
  const blue = gradeFor([0.4, 0.45, 0.6], sand, daylight);
  for (const gain of blue.tint) expect(Math.abs(gain - 1)).toBeLessThanOrEqual(0.1 + 1e-9);
  expect(gradeFor([0.3, 0.277, 0.204], sand, daylight).gamma).toBeGreaterThan(
    Math.log(0.522) / Math.log(0.277),
  );
  const infrared = gradeFor([0.2, 0.2, 0.2], sand, daylight);
  // Warmed toward the daylight's white, but never into one sepia.
  for (const gain of infrared.tone) expect(Math.abs(gain - 1)).toBeLessThanOrEqual(0.1 + 1e-9);
  expect(infrared.gamma).toBeCloseTo((1 + Math.log(0.522) / Math.log(0.2)) / 2);
  expect(infrared.keep).toBe(0);
  const pixel = new Uint8ClampedArray([51, 51, 51, 255]);
  applyGrade(pixel, infrared);
  expect(pixel[0]).toBeGreaterThan(pixel[1] ?? 0);
  expect(pixel[1]).toBeGreaterThan(pixel[2] ?? 0);
  expect(pixel[3]).toBe(255);
});

test('the matte keeps what differs from the rest of its burst, not where the animal went next', () => {
  const size = 40;
  const ground = new Uint8ClampedArray(size * size * 4).fill(150);
  const square = (frame: Uint8ClampedArray, left: number, light: number) => {
    for (let y = 14; y < 26; y++) {
      for (let x = left; x < left + 10; x++)
        frame.fill(40, (y * size + x) * 4, (y * size + x) * 4 + 3);
    }
    // The same ground a little darker, as the light changes through a burst.
    return frame.map((value, i) => (i % 4 === 3 ? value : value * light));
  };
  const print = square(ground.slice(), 10, 1);
  const alpha = animalMatte(print, [square(ground.slice(), 21, 0.9), ground.slice()], size, size);
  expect(alpha[20 * size + 14]).toBeGreaterThan(0.95);
  expect(alpha[20 * size + 26]).toBe(0);
  expect(alpha[5 * size + 5]).toBe(0);
  expect(alpha[20 * size + 1]).toBe(0);
});

test('a scrap of changed ground beside the animal is dropped', () => {
  const size = 40;
  const ground = new Uint8ClampedArray(size * size * 4).fill(150);
  const print = ground.slice();
  const dark = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) print.fill(40, (y * size + x) * 4, (y * size + x) * 4 + 3);
    }
  };
  dark(12, 14, 14, 12);
  dark(29, 5, 6, 6);
  const alpha = animalMatte(print, [ground.slice(), ground.slice()], size, size);
  expect(alpha[20 * size + 18]).toBeGreaterThan(0.95);
  expect(alpha[8 * size + 32]).toBe(0);
});

test('an animal that held still through its burst is still found', () => {
  const size = 40;
  const ground = new Uint8ClampedArray(size * size * 4).fill(150);
  const print = ground.slice();
  for (let y = 14; y < 26; y++) {
    for (let x = 12; x < 28; x++) print.fill(40, (y * size + x) * 4, (y * size + x) * 4 + 3);
  }
  const alpha = animalMatte(print, [print.slice(), ground], size, size);
  expect(alpha[20 * size + 20]).toBeGreaterThan(0.95);
  expect(alpha[5 * size + 5]).toBe(0);
});

test('each fragment goes to its best photo, and no photo takes more than its share', () => {
  const scores = [
    [0.9, 0.8, 0.7],
    [0.5, 0.6, 0.1],
    [0, 0, 0.2],
  ];
  expect(assignFragments(scores, 2)).toEqual([0, 0, 2]);
  expect(assignFragments(scores, 1)).toEqual([0, 1, 2]);
});

test('a crop too dark or too flat to show anything is not readable', () => {
  expect(readable(new Float32Array(64).fill(0.5))).toBe(false);
  expect(readable(Float32Array.from({ length: 64 }, (_, i) => (i % 2 ? 0.08 : 0.12)))).toBe(false);
  expect(readable(Float32Array.from({ length: 64 }, (_, i) => (i % 2 ? 0.3 : 0.6)))).toBe(true);
  expect(exposure([0.2, 0.4]).mean).toBeCloseTo(0.3);
});

test('a print whose ground is paler than the frame around it is brought down to it', () => {
  const size = 20;
  const print = new Uint8ClampedArray(size * size * 4).fill(200);
  const ground = new Uint8ClampedArray(size * size * 4).fill(100);
  // The animal at the centre of the print is not ground and does not move the gains.
  for (let y = 8; y < 12; y++) print.fill(20, (y * size + 8) * 4, (y * size + 12) * 4);
  for (const gain of ringGains(print, ground, size, size)) expect(gain).toBeCloseTo(0.5, 2);
});

test('a limb-thin strip of changed ground attached to the animal is worn away', () => {
  const size = 40;
  const ground = new Uint8ClampedArray(size * size * 4).fill(150);
  const print = ground.slice();
  const dark = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) print.fill(40, (y * size + x) * 4, (y * size + x) * 4 + 3);
    }
  };
  dark(10, 12, 14, 12);
  dark(24, 17, 6, 2);
  const alpha = animalMatte(print, [ground.slice(), ground.slice()], size, size);
  expect(alpha[18 * size + 16]).toBeGreaterThan(0.95);
  expect(alpha[18 * size + 28]).toBeLessThan(0.05);
});

test('a print laid by day is scaled, pushed toward the edges and kept inside the frame', () => {
  const rect = [0.6, 0.6, 0.12, 0.16] as const;
  const scales = Array.from({ length: 40 }, (_, index) => laidRect(rect, index)[2] / rect[2]);
  expect(Math.min(...scales)).toBeGreaterThanOrEqual(0.6);
  expect(Math.max(...scales)).toBeLessThanOrEqual(1.6);
  expect(Math.max(...scales) - Math.min(...scales)).toBeGreaterThan(0.5);
  for (let index = 0; index < 40; index++) {
    const [x, y, w, h] = laidRect(rect, index);
    expect(x + w / 2).toBeGreaterThan(rect[0] + rect[2] / 2);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x + w).toBeLessThanOrEqual(1);
    expect(y + h).toBeLessThanOrEqual(0.975);
    expect(Math.max(w, h)).toBeLessThanOrEqual(0.45);
  }
  const [x, , w] = laidRect([0.85, 0.5, 0.14, 0.2], 3);
  expect(x + w).toBeLessThanOrEqual(1);
});
