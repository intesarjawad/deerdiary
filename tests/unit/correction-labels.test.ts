import { readFile } from 'node:fs/promises';
import { expect, test, vi } from 'vitest';
import { correctionLabels, loadCorrectionVocabulary } from '../../src/app/correctionLabels';
import type { CameraTime } from '../../src/core/time';
import type { DeerdiaryEvent, PhotoResult } from '../../src/core/types';

const time: CameraTime = {
  wallClockMs: Date.UTC(2026, 10, 1),
  wallClockHour: 0,
  timeSource: 'exif',
  offsetTimeOriginal: null,
  clockStatus: 'ok',
};

const deer = 'deer-uuid;mammalia;artiodactyla;cervidae;odocoileus;virginianus;white-tailed deer';
const fox = 'fox-uuid;mammalia;carnivora;canidae;vulpes;vulpes;red fox';

function photo(path: string): PhotoResult {
  return { path, time, detections: [] };
}

function event(cameraKey: string, labels: readonly string[]): DeerdiaryEvent {
  const bestPhoto = photo(`${cameraKey}/a.jpg`);
  return {
    cameraKey,
    photos: [bestPhoto],
    species: labels.map((label) => ({ label, bestPhoto })),
  };
}

test('offers each species once, in sorted order, including an existing correction target', () => {
  const events = [event('alpha', [fox, deer]), event('beta', [deer])];

  expect(correctionLabels(events, { 'alpha@0\u0000x': 'moose' })).toEqual(
    expect.arrayContaining([deer, fox, 'moose']),
  );
});

test('a diary with no species still offers the corrections it already holds', () => {
  expect(correctionLabels([], { key: 'moose' })).toEqual(expect.arrayContaining(['moose']));
});

test('offers the full SpeciesNet vocabulary without a detected bear or model download', async () => {
  const body = await readFile('src/app/speciesnet-labels.txt', 'utf8');
  const fetcher = vi.fn(async () => new Response(body));
  vi.stubGlobal('fetch', fetcher);
  const labels = correctionLabels([], {}, await loadCorrectionVocabulary());
  vi.unstubAllGlobals();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(labels).toHaveLength(2498);
  expect(labels.some((label) => label.endsWith(';american black bear'))).toBe(true);
  expect(new Set(labels).size).toBe(labels.length);
});
