import { type CamtrapDpInput, toCamtrapDp } from '../core/camtrapDp';
import { correctDetection, correctedEvents, eventId } from '../core/corrections';
import { type CsvRow, toCsv } from '../core/csv';
import { cameraKey } from '../core/events';
import { DEFAULT_INDEPENDENCE_INTERVAL_MIN, independentDetections } from '../core/independence';
import { megaDetectorExportFromResults, toMegaDetectorJson } from '../core/megadetectorJson';
import {
  type SpeciesNetEvent,
  type SpeciesNetImage,
  toSpeciesNetJson,
} from '../core/speciesnetJson';
import type { DeerdiaryEvent } from '../core/types';
import type { StoredResult } from '../storage/schema';

export { correctionKey, eventId } from '../core/corrections';

export type ExportInput = {
  camtrap?: Pick<CamtrapDpInput, 'locations' | 'project' | 'contributors'>;
  results: readonly StoredResult[];
  events: readonly DeerdiaryEvent[];
  corrections?: Readonly<Record<string, string>>;
  independenceIntervalMin?: number;
  /** The detector the results came from, recorded in the MegaDetector file. */
  detector?: string;
};

function labelParts(label: string): readonly string[] {
  return label.split(';');
}

function commonName(label: string): string | null {
  return labelParts(label).at(-1) || null;
}

function scientificName(label: string): string | null {
  const parts = labelParts(label);
  return [parts[4], parts[5]].filter(Boolean).join(' ') || null;
}

function correctedResults(input: ExportInput): StoredResult[] {
  const byPath = eventsByPath(input.events);
  return input.results.map((stored) => {
    const { output } = stored;
    const event = byPath.get(output.path);
    if (output.status !== 'ok' || event === undefined) return stored;
    return {
      ...stored,
      output: {
        ...output,
        detections: output.detections.map((detection) =>
          correctDetection(detection, event, input.corrections ?? {}),
        ),
      },
    };
  });
}

function independentKeys(input: ExportInput): Set<string> {
  const interval = input.independenceIntervalMin ?? DEFAULT_INDEPENDENCE_INTERVAL_MIN;
  return new Set(
    independentDetections(correctedEvents(input.events, input.corrections ?? {}), interval).map(
      (detection) => `${eventId(detection.event)}\u0000${detection.label}`,
    ),
  );
}

function eventsByPath(events: readonly DeerdiaryEvent[]): Map<string, DeerdiaryEvent> {
  const paths = new Map<string, DeerdiaryEvent>();
  for (const event of events) {
    for (const photo of event.photos) paths.set(photo.path, event);
  }
  return paths;
}

/** Builds one CSV row per detection, including the burst and independence columns analysts group by. */
export function buildCsvRows(input: ExportInput): CsvRow[] {
  const corrections = input.corrections ?? {};
  const independent = independentKeys(input);
  const byPath = eventsByPath(input.events);
  const rows: CsvRow[] = [];
  for (const { output, time } of input.results) {
    if (output.status !== 'ok') continue;
    const event = byPath.get(output.path);
    const id = event ? eventId(event) : null;
    output.detections.forEach((detection, index) => {
      const machine = detection.processed_classification;
      const processed =
        event === undefined
          ? machine
          : correctDetection(detection, event, corrections).processed_classification;
      rows.push({
        path: output.path,
        camera: cameraKey(output.path),
        wall_clock: new Date(time.wallClockMs).toISOString(),
        time_source: time.timeSource,
        event_id: id,
        independent:
          event !== undefined &&
          processed !== undefined &&
          independent.has(`${eventId(event)}\u0000${processed.class}`),
        detection_index: index,
        detector_label: detection.label,
        detector_conf: detection.conf,
        bbox_x: detection.bbox[0],
        bbox_y: detection.bbox[1],
        bbox_w: detection.bbox[2],
        bbox_h: detection.bbox[3],
        label_uuid: processed ? labelParts(processed.class)[0] || null : null,
        common_name: processed ? commonName(processed.class) : null,
        scientific_name: processed ? scientificName(processed.class) : null,
        score: processed?.score ?? null,
        source: processed?.source ?? null,
        corrected_common_name: processed?.source === 'human' ? commonName(processed.class) : null,
        machine_label: machine?.class ?? null,
        machine_score: machine?.score ?? null,
        machine_source: machine?.source ?? null,
      });
    });
  }
  return rows;
}

/** Writes the CSV with this module's fixed column order, RFC 4180 quoting and a UTF-8 BOM. */
export function exportCsv(input: ExportInput): string {
  return toCsv(buildCsvRows(input));
}

function exportedEvents(events: readonly DeerdiaryEvent[]): SpeciesNetEvent[] {
  return events.map((event) => ({
    id: eventId(event),
    camera: event.cameraKey,
    photos: event.photos.map((photo) => photo.path),
    species: event.species.map((species) => species.label),
  }));
}

function exportedPredictions(
  results: readonly StoredResult[],
  originals?: readonly StoredResult[],
): SpeciesNetImage[] {
  return results.map(({ output }, resultIndex) => {
    if (output.status !== 'ok')
      return { filepath: output.path, failures: ['DECODE_FAILED'], detections: [] };
    const original = originals?.[resultIndex]?.output;
    return {
      filepath: output.path,
      detections: output.detections.map((detection, detectionIndex) => {
        const machine =
          original?.status === 'ok'
            ? original.detections[detectionIndex]?.processed_classification
            : undefined;
        return {
          category: detection.category,
          label: detection.label,
          conf: detection.conf,
          bbox: detection.bbox,
          ...(machine !== undefined && detection.processed_classification !== machine
            ? { machine_classification: machine }
            : {}),
          ...(detection.raw_classifications === undefined
            ? {}
            : { raw_classifications: detection.raw_classifications }),
          ...(detection.processed_classification === undefined
            ? {}
            : { processed_classification: detection.processed_classification }),
        };
      }),
    };
  });
}

/** Writes SpeciesNet predictions plus the event and correction data needed to import them again. */
export function exportJson(input: ExportInput): string {
  return toSpeciesNetJson({
    predictions: exportedPredictions(correctedResults(input), input.results),
    events: exportedEvents(correctedEvents(input.events, input.corrections ?? {})),
    corrections: input.corrections ?? {},
    independenceIntervalMin: input.independenceIntervalMin ?? DEFAULT_INDEPENDENCE_INTERVAL_MIN,
  });
}

export type ExportFile = { name: string; type: string; text: string };

export type DiaryExports = {
  csv: ExportFile;
  json: ExportFile;
  megadetector: ExportFile;
  camtrapDp: readonly ExportFile[];
};

/**
 * The files a finished diary offers. Camtrap DP stays four files with the names its datapackage
 * declares, because the package describes them as paths inside one folder.
 */
export function diaryExports(input: ExportInput, created: string): DiaryExports {
  return {
    csv: { name: 'deerdiary.csv', type: 'text/csv;charset=utf-8', text: exportCsv(input) },
    json: {
      name: 'speciesnet.json',
      type: 'application/json;charset=utf-8',
      text: exportJson(input),
    },
    megadetector: {
      name: 'megadetector.json',
      type: 'application/json;charset=utf-8',
      text: toMegaDetectorJson({
        ...megaDetectorExportFromResults(correctedResults(input)),
        deerdiary: {
          corrections: input.corrections ?? {},
          machine_predictions: exportedPredictions(input.results),
        },
        ...(input.detector === undefined ? {} : { detector: input.detector }),
      }),
    },
    get camtrapDp() {
      const camtrap = toCamtrapDp({
        ...input.camtrap,
        results: input.results,
        events: input.events,
        corrections: input.corrections ?? {},
        created,
      });
      return [
        {
          name: 'datapackage.json',
          type: 'application/json;charset=utf-8',
          text: camtrap.datapackage,
        },
        { name: 'deployments.csv', type: 'text/csv;charset=utf-8', text: camtrap.deployments },
        { name: 'media.csv', type: 'text/csv;charset=utf-8', text: camtrap.media },
        { name: 'observations.csv', type: 'text/csv;charset=utf-8', text: camtrap.observations },
      ];
    },
  };
}
