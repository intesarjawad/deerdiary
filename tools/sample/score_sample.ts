import { readFile } from 'node:fs/promises';
import { burstCounter, groupEvents } from '../../src/core/events';
import {
  DEFAULT_INDEPENDENCE_INTERVAL_MIN,
  independentDetections,
} from '../../src/core/independence';
import { parseSpeciesNet, type SpeciesNetImage } from '../../src/core/speciesnetJson';
import type { DeerdiaryEvent, Detection, PhotoResult } from '../../src/core/types';
import { diarySpecies } from '../../src/ui/Diary';

/**
 * Scores the instant sample's diary against the dataset's own labels: which empty frames still
 * add to a card, which card each labelled photo lands on, and how many independent detections
 * each card holds next to the dataset's. The diary is rebuilt by the app's own code from the
 * SpeciesNet export that `npm run sample:predict` writes; capture times come from the provenance
 * table, which records the time written into each photo.
 *
 * Usage: tsx tools/sample/score_sample.ts [predictions.json] [PROVENANCE.txt]
 */

const DEFAULT_PREDICTIONS = 'public/sample/predictions.json';
const DEFAULT_PROVENANCE = 'public/sample/PROVENANCE.txt';
// The dataset's label for a frame with nothing in it.
const EMPTY = 'empty';
const NO_CARD = '(no card)';
// One provenance row: file, sequence, frame, capture date and time, dataset label, sha256.
const PROVENANCE_ROW =
  /^(\S+\.jpg)\s+\S+\s+\d+\s+(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\s+(\S+)\s+[0-9a-f]{64}$/;

export type SamplePhoto = { label: string; wallClockMs: number };

export type SampleScore = {
  photoCount: number;
  emptyCount: number;
  /** File names the dataset calls empty that still add to at least one card. */
  emptyWithCard: readonly string[];
  /** Photos per dataset label and diary card. */
  confusion: ReadonlyMap<string, ReadonlyMap<string, number>>;
  cards: readonly {
    name: string;
    detections: number;
    photoCount: number;
    maxN: number;
    byLabel: ReadonlyMap<string, number>;
  }[];
  /** Independent detections the dataset's labels give under the same rule. */
  datasetDetections: ReadonlyMap<string, number>;
};

/** Reads each sample photo's dataset label and capture time from the provenance table. */
export function parseProvenance(text: string): Map<string, SamplePhoto> {
  const photos = new Map<string, SamplePhoto>();
  for (const line of text.split('\n')) {
    const row = PROVENANCE_ROW.exec(line.trim());
    if (!row) continue;
    const [, name = '', year, month, day, hour, minute, second, label = ''] = row;
    photos.set(name, {
      label,
      // Capture times are camera wall-clock readings, encoded as the app encodes EXIF.
      wallClockMs: Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
      ),
    });
  }
  return photos;
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function increment<K>(counts: Map<K, number>, key: K): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function samplePhoto(sample: ReadonlyMap<string, SamplePhoto>, path: string): SamplePhoto {
  const photo = sample.get(fileName(path));
  if (photo === undefined) throw new Error(`${path} has no row in the provenance table.`);
  return photo;
}

function datasetLabel(sample: ReadonlyMap<string, SamplePhoto>, path: string): string {
  return samplePhoto(sample, path).label;
}

function isCategory(value: string): value is Detection['category'] {
  return value === '1' || value === '2' || value === '3';
}

function photoResults(
  predictions: readonly SpeciesNetImage[],
  sample: ReadonlyMap<string, SamplePhoto>,
): PhotoResult[] {
  return predictions.map(({ filepath, detections }) => {
    const { wallClockMs } = samplePhoto(sample, filepath);
    return {
      path: filepath,
      time: {
        wallClockMs,
        wallClockHour: new Date(wallClockMs).getUTCHours(),
        timeSource: 'exif',
        offsetTimeOriginal: null,
        clockStatus: 'ok',
      },
      detections: detections.map(({ category, conf, bbox, processed_classification }) => {
        if (!isCategory(category))
          throw new Error(`${filepath} has detector category ${category}.`);
        return {
          category,
          conf,
          bbox,
          ...(processed_classification === undefined ? {} : { processed_classification }),
        };
      }),
    };
  });
}

/** Each photo's dataset label as one confident detection, so the app's rules count them. */
function datasetPhotos(photos: readonly PhotoResult[], sample: ReadonlyMap<string, SamplePhoto>) {
  return photos.map((photo): PhotoResult => {
    const label = datasetLabel(sample, photo.path);
    return {
      ...photo,
      detections:
        label === EMPTY
          ? []
          : [
              {
                category: '1',
                conf: 1,
                bbox: [0, 0, 1, 1],
                processed_classification: { class: label, score: 1, source: 'classifier' },
              },
            ],
    };
  });
}

function cardDetectionsByLabel(
  events: readonly DeerdiaryEvent[],
  cards: ReturnType<typeof diarySpecies>,
  sample: ReadonlyMap<string, SamplePhoto>,
): Map<string, Map<string, number>> {
  // The diary counts a card once per event even when several of its labels open that event.
  const counted = new Map<string, Set<DeerdiaryEvent>>();
  for (const detection of independentDetections(events, DEFAULT_INDEPENDENCE_INTERVAL_MIN)) {
    const card = cards.find(({ labels: cardLabels }) => cardLabels.includes(detection.label));
    if (!card) continue;
    const seen = counted.get(card.name) ?? new Set();
    seen.add(detection.event);
    counted.set(card.name, seen);
  }
  const byCard = new Map<string, Map<string, number>>();
  for (const [name, seen] of counted) {
    const byLabel = new Map<string, number>();
    for (const event of seen) {
      const first = event.photos[0];
      if (first) increment(byLabel, datasetLabel(sample, first.path));
    }
    byCard.set(name, byLabel);
  }
  return byCard;
}

/** Scores the diary the app builds from `predictions` against the dataset labels by file name. */
export function scoreSample(
  predictions: readonly SpeciesNetImage[],
  sample: ReadonlyMap<string, SamplePhoto>,
): SampleScore {
  const photos = photoResults(predictions, sample);
  const events = groupEvents(photos);
  const cards = diarySpecies(events);

  const emptyWithCard: string[] = [];
  const confusion = new Map<string, Map<string, number>>();
  for (const event of events) {
    // A photo's cards depend on its burst, so each photo is scored as the diary counted it there.
    const counted = burstCounter(event.photos);
    for (const photo of event.photos) {
      const label = datasetLabel(sample, photo.path);
      const names = new Set(
        photo.detections.flatMap((detection) => {
          const countedLabel = counted(detection);
          const card = cards.find(({ labels }) => countedLabel && labels.includes(countedLabel));
          return card ? [card.name] : [];
        }),
      );
      if (label === EMPTY && names.size > 0) emptyWithCard.push(fileName(photo.path));
      const row = confusion.get(label) ?? new Map<string, number>();
      for (const name of names.size > 0 ? names : [NO_CARD]) increment(row, name);
      confusion.set(label, row);
    }
  }

  const byCard = cardDetectionsByLabel(events, cards, sample);
  const datasetDetections = new Map<string, number>();
  for (const card of diarySpecies(groupEvents(datasetPhotos(photos, sample)))) {
    datasetDetections.set(card.name, card.detections);
  }
  return {
    photoCount: photos.length,
    emptyCount: photos.filter((photo) => datasetLabel(sample, photo.path) === EMPTY).length,
    emptyWithCard: emptyWithCard.toSorted(),
    confusion,
    cards: cards.map(({ name, detections, photoCount, maxN }) => ({
      name,
      detections,
      photoCount,
      maxN,
      byLabel: byCard.get(name) ?? new Map(),
    })),
    datasetDetections,
  };
}

function tally(counts: ReadonlyMap<string, number>): string {
  return Array.from(counts)
    .toSorted(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b))
    .map(([name, count]) => `${name} ${count}`)
    .join(', ');
}

/** Renders the score as plain text tables. */
export function formatScore(score: SampleScore): string {
  const lines = [
    `${score.photoCount} photos, ${score.emptyCount} empty by the dataset's labels.`,
    `Empty frames that add to a card: ${score.emptyWithCard.length} of ${score.emptyCount}${
      score.emptyWithCard.length > 0 ? ` (${score.emptyWithCard.join(', ')})` : ''
    }`,
    '',
    'Photos by dataset label -> diary cards',
  ];
  for (const [label, row] of Array.from(score.confusion).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    lines.push(`  ${label.padEnd(10)} ${tally(row)}`);
  }
  lines.push('', 'Independent detections per card, by the dataset label of the burst');
  for (const card of score.cards) {
    lines.push(
      `  ${card.name.padEnd(24)} ${String(card.detections).padStart(3)}  photos ${card.photoCount}, MaxN ${card.maxN}  ${tally(card.byLabel)}`,
    );
  }
  lines.push('', `Dataset independent detections: ${tally(score.datasetDetections)}`);
  return lines.join('\n');
}

if (import.meta.main) {
  const [predictionsPath = DEFAULT_PREDICTIONS, provenancePath = DEFAULT_PROVENANCE] =
    process.argv.slice(2);
  const parsed = parseSpeciesNet(JSON.parse(await readFile(predictionsPath, 'utf8')));
  if (!parsed.ok) {
    console.error(
      `${predictionsPath} has a bad "${parsed.field}" field. Write it again with npm run sample:predict.`,
    );
    process.exit(1);
  }
  const sample = parseProvenance(await readFile(provenancePath, 'utf8'));
  console.log(formatScore(scoreSample(parsed.value.predictions, sample)));
}
