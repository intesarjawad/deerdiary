import { expect, test } from 'vitest';
import type { ScannedFile } from '../../src/files/scan';
import { emptyFolderMessage } from '../../src/ui/DropZone';
import { longWord, nameLines, zoomTransform } from '../../src/ui/FoldPlate';
import { cropGeometry } from '../../src/ui/Portrait';

const file = (ext: string) => ({ ext }) as unknown as ScannedFile;

test('zoomTransform keeps the box inside the zoom window', () => {
  const match = /scale\(([\d.]+)\) translate\((-?[\d.]+)%, (-?[\d.]+)%\)/.exec(
    zoomTransform([0.6, 0.5, 0.1, 0.1]),
  );
  expect(match).not.toBeNull();
  const [scale, tx, ty] = (match as RegExpExecArray).slice(1).map(Number) as [
    number,
    number,
    number,
  ];
  const window = 1 / scale;
  const left = -tx / 100;
  const top = -ty / 100;
  expect(left).toBeLessThanOrEqual(0.6);
  expect(left + window).toBeGreaterThanOrEqual(0.7);
  expect(top).toBeLessThanOrEqual(0.5);
  expect(top + window).toBeGreaterThanOrEqual(0.6);
});

test('zoomTransform clamps a box at the frame edge and never zooms past 5x', () => {
  expect(zoomTransform([0, 0, 0.02, 0.02])).toBe('scale(5) translate(0%, 0%)');
  expect(zoomTransform([0.2, 0.2, 0.9, 0.9])).toBe('scale(1) translate(0%, 0%)');
});

test('emptyFolderMessage tells an empty folder from one with other files', () => {
  expect(emptyFolderMessage([]).title).toBe('That folder is empty.');
  const other = emptyFolderMessage([file('db'), file('txt'), file('db')]);
  expect(other.title).toBe('No photos in that folder.');
  expect(other.body).toContain('3 files');
  expect(other.body).toContain('.db, .txt');
});

test('nameLines wraps at word boundaries and only breaks a word longer than the column', () => {
  expect(nameLines('coyote', 11)).toBe(1);
  expect(nameLines('virginia opossum', 11)).toBe(2);
  expect(nameLines('Mephitis-mephitis-mephitis', 11)).toBe(3);
});

test('cropGeometry fills the window with the animal, and never enlarges a tiny subject', () => {
  const natural = { width: 1600, height: 1200 };
  const crop = cropGeometry(400, 360, natural, [0.4, 0.4, 0.2, 0.2]);
  expect(crop.mode).toBe('crop');
  expect(crop.width).toBeGreaterThan(natural.width / 2);
  expect(crop.left).toBeLessThanOrEqual(0);
  expect(crop.left + crop.width).toBeGreaterThanOrEqual(400);
  const tiny = cropGeometry(400, 360, natural, [0.4, 0.4, 0.02, 0.02]);
  expect(tiny.mode).toBe('whole');
  expect(tiny.height).toBeGreaterThanOrEqual(360);
  expect(tiny.width / natural.width).toBeLessThan(1);
});

test('longWord flags only labels with a word wider than the column', () => {
  expect(longWord('northern raccoon', 11)).toBe(false);
  expect(longWord('extraordinarily long', 11)).toBe(true);
});
