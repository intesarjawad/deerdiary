import { expect, test } from 'vitest';
import { buildCsvRows, diaryExports } from '../../src/app/export';
import { groupEvents } from '../../src/core/events';
import { sessionSummaries } from '../../src/core/history';
import { reelEndCard } from '../../src/core/reel';
import type { CameraTime } from '../../src/core/time';
import type { StoredResult } from '../../src/storage/schema';
import { diarySpecies } from '../../src/ui/Diary';
import type { ClassifiedDetection } from '../../src/workers/photo';

const animal = '1f689929-883d-4dae-958c-3d57ab5b6c16;;;;;;animal';
const leporids = 'id;mammalia;lagomorpha;leporidae;;;rabbit and hare family';
const snowshoe = 'id;mammalia;lagomorpha;leporidae;lepus;americanus;snowshoe hare';
const coyote = 'id;mammalia;carnivora;canidae;canis;latrans;coyote';
const start = Date.UTC(2026, 10, 1, 2, 0, 0);

// Boxes sit side by side, so each is a separate animal.
function box(label: string, index: number): ClassifiedDetection {
  return {
    category: '1',
    label: 'animal',
    conf: 0.9,
    bbox: [index * 0.25, 0.1, 0.2, 0.2],
    processed_classification: { class: label, score: 0.8, source: 'classifier' },
  };
}

function stored(name: string, offsetMs: number, labels: readonly string[]): StoredResult {
  const path = `card/DCIM/100MEDIA/${name}.jpg`;
  const time: CameraTime = {
    wallClockMs: start + offsetMs,
    wallClockHour: 2,
    timeSource: 'exif',
    offsetTimeOriginal: null,
    clockStatus: 'ok',
  };
  return {
    key: path,
    time,
    output: {
      path,
      backend: 'wasm',
      ms: { decode: 0, preprocess: 0, detect: 0, classify: 0, ensemble: 0, thumbnail: 0, total: 0 },
      status: 'ok',
      width: 100,
      height: 80,
      thumbnail: new Blob(['preview']),
      detections: labels.map(box),
    },
  };
}

const hour = 60 * 60 * 1000;
// Two bursts an hour apart: a family box beside its one species, and a fallback box beside a coyote.
const results = [
  stored('a', 0, [leporids]),
  stored('b', 10_000, [snowshoe]),
  stored('c', hour, [coyote, animal]),
];
const events = groupEvents(
  results.map(({ output, time }) => ({
    path: output.path,
    time,
    detections: output.status === 'ok' ? output.detections : [],
  })),
);
const counted = new Map([
  ['snowshoe hare', 1],
  ['coyote', 1],
]);

test('every species count a person reads agrees once a burst folds', () => {
  const cards = diarySpecies(events);
  expect(new Map(cards.map((card) => [card.name, card.detections]))).toEqual(counted);
  expect(cards.find((card) => card.name === 'coyote')?.maxN).toBe(2);

  const end = reelEndCard(events, { name: 'Ridge' });
  expect(new Map(end.species.map((species) => [species.name, species.detections]))).toEqual(
    counted,
  );

  const [summary] = sessionSummaries(
    [
      {
        id: 's',
        createdAtMs: start,
        fileKeys: results.map((result) => result.key),
        dateRange: null,
      },
    ],
    results,
  );
  expect(new Map(summary?.species.map((species) => [species.name, species.detections]))).toEqual(
    counted,
  );

  const independent = new Map<string, Set<string>>();
  for (const row of buildCsvRows({ results, events })) {
    if (!row.independent) continue;
    const name = String(row.common_name);
    const seen = independent.get(name) ?? new Set();
    independent.set(name, seen.add(String(row.event_id)));
  }
  expect(new Map(Array.from(independent, ([name, ids]) => [name, ids.size]))).toEqual(counted);
});

test('per-box exports keep each box its own label while event tables count the fold', () => {
  const files = diaryExports(
    {
      results,
      events,
      camtrap: {
        locations: { 'card/DCIM': { latitude: 0, longitude: 0 } },
        project: {
          title: 'Test project',
          samplingDesign: 'opportunistic',
          individualAnimals: false,
        },
        contributors: [{ title: 'Test contributor' }],
      },
    },
    '2026-11-09T00:00:00Z',
  );

  const rows = buildCsvRows({ results, events });
  expect(rows.map((row) => row.common_name)).toEqual([
    'rabbit and hare family',
    'snowshoe hare',
    'coyote',
    'animal',
  ]);

  const json = JSON.parse(files.json.text);
  expect(
    json.predictions.flatMap((prediction: { detections: ClassifiedDetection[] }) =>
      prediction.detections.map((detection) => detection.processed_classification?.class),
    ),
  ).toEqual([leporids, snowshoe, coyote, animal]);
  expect(json.deerdiary.events.map((event: { species: string[] }) => event.species)).toEqual([
    [snowshoe],
    [coyote],
  ]);

  expect(files.megadetector.text).toContain('rabbit and hare family');

  // Camtrap DP observations are event-level, so they count the fold like the diary does.
  const observations = files.camtrapDp
    .find((file) => file.name === 'observations.csv')
    ?.text.trim()
    .split(/\r?\n/)
    .slice(1);
  expect(observations).toHaveLength(2);
  expect(observations?.[0]).toMatch(/,lepus americanus,1,/);
  expect(observations?.[1]).toMatch(/,canis latrans,2,/);
});
