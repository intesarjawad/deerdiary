import type { StoredResult } from '../storage/schema';
import { correctedEvents, correctionKey } from './corrections';
import { csvField } from './csv';
import { burstCounter, cameraKey, maxN } from './events';
import type { CameraTime } from './time';
import type { DeerdiaryEvent } from './types';

export const CAMTRAP_DP_VERSION = '1.0.2';
export const CAMTRAP_DP_PROFILE_URL =
  'https://raw.githubusercontent.com/tdwg/camtrap-dp/1.0.2/camtrap-dp-profile.json';
export const CLASSIFIED_BY = 'SpeciesNet v4.0.3a via Deerdiary';

const SCHEMA_BASE = 'https://raw.githubusercontent.com/tdwg/camtrap-dp/1.0.2';

export type CamtrapDpLocation = {
  latitude: number;
  longitude: number;
  locationID?: string;
  locationName?: string;
  coordinateUncertainty?: number;
};

export type CamtrapDpInput = {
  results: readonly StoredResult[];
  events: readonly DeerdiaryEvent[];
  corrections?: Readonly<Record<string, string>>;
  created: string;
  title?: string;
  locations?: Readonly<Record<string, CamtrapDpLocation>>;
  contributors?: readonly { title: string }[];
  project?: {
    title: string;
    samplingDesign:
      | 'simpleRandom'
      | 'systematicRandom'
      | 'clusteredRandom'
      | 'experimental'
      | 'targeted'
      | 'opportunistic';
    individualAnimals: boolean;
  };
};

export type CamtrapDpFiles = {
  datapackage: string;
  deployments: string;
  media: string;
  observations: string;
};

type Cell = string | number | boolean | null;
type Row = readonly Cell[];

const DEPLOYMENT_COLUMNS = [
  'deploymentID',
  'locationID',
  'locationName',
  'latitude',
  'longitude',
  'coordinateUncertainty',
  'deploymentStart',
  'deploymentEnd',
  'setupBy',
  'cameraID',
  'cameraModel',
  'cameraDelay',
  'cameraHeight',
  'cameraDepth',
  'cameraTilt',
  'cameraHeading',
  'detectionDistance',
  'timestampIssues',
  'baitUse',
  'featureType',
  'habitat',
  'deploymentGroups',
  'deploymentTags',
  'deploymentComments',
] as const;

const MEDIA_COLUMNS = [
  'mediaID',
  'deploymentID',
  'captureMethod',
  'timestamp',
  'filePath',
  'filePublic',
  'fileName',
  'fileMediatype',
  'exifData',
  'favorite',
  'mediaComments',
] as const;

const OBSERVATION_COLUMNS = [
  'observationID',
  'deploymentID',
  'mediaID',
  'eventID',
  'eventStart',
  'eventEnd',
  'observationLevel',
  'observationType',
  'cameraSetupType',
  'scientificName',
  'count',
  'lifeStage',
  'sex',
  'behavior',
  'individualID',
  'individualPositionRadius',
  'individualPositionAngle',
  'individualSpeed',
  'bboxX',
  'bboxY',
  'bboxWidth',
  'bboxHeight',
  'classificationMethod',
  'classifiedBy',
  'classificationTimestamp',
  'classificationProbability',
  'observationTags',
  'observationComments',
] as const;

function table(columns: readonly string[], rows: readonly Row[]): string {
  return `${[columns.join(','), ...rows.map((row) => row.map(csvField).join(','))].join('\r\n')}\r\n`;
}

function iso(time: CameraTime): string {
  const offset = time.offsetTimeOriginal ?? 'Z';
  if (!/^(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(offset)) {
    throw new Error(`Camtrap DP requires a valid camera timezone offset: ${offset}`);
  }
  return new Date(time.wallClockMs).toISOString().slice(0, 19) + offset;
}

function eventId(event: DeerdiaryEvent): string {
  return `${event.cameraKey}@${event.photos[0]?.time.wallClockMs ?? 0}`;
}

function eventStart(event: DeerdiaryEvent): number {
  return event.photos[0]?.time.wallClockMs ?? 0;
}

function labelParts(label: string): readonly string[] {
  return label.split(';');
}

function commonName(label: string): string {
  return labelParts(label).at(-1) || label;
}

function scientificName(label: string): string {
  const parts = labelParts(label);
  const genus = parts[4];
  const species = parts[5];
  return genus && species ? `${genus} ${species}` : '';
}

function observationType(label: string): 'animal' | 'human' | 'vehicle' | 'blank' | 'unknown' {
  const name = commonName(label);
  if (name === 'no cv result') return 'unknown';
  return name === 'human' || name === 'vehicle' || name === 'blank' || name === 'unknown'
    ? name
    : 'animal';
}

function labelScore(event: DeerdiaryEvent, label: string): number | null {
  const counted = burstCounter(event.photos);
  let score: number | null = null;
  for (const photo of event.photos) {
    for (const detection of photo.detections) {
      const classification = detection.processed_classification;
      if (classification && (counted(detection) ?? classification.class) === label)
        score = Math.max(score ?? 0, classification.score);
    }
  }
  return score;
}

function mediaType(path: string): string {
  switch (path.split('.').at(-1)?.toLowerCase()) {
    case 'png':
      return 'image/png';
    case 'tif':
    case 'tiff':
      return 'image/tiff';
    case 'mp4':
      return 'video/mp4';
    case 'mov':
      return 'video/quicktime';
    case 'avi':
      return 'video/x-msvideo';
    default:
      return 'image/jpeg';
  }
}

type Deployment = {
  id: string;
  start: CameraTime;
  end: CameraTime;
  timestampIssues: boolean;
};

function deployments(results: readonly StoredResult[]): Deployment[] {
  const byCamera = new Map<string, Deployment>();
  for (const { output, time } of results) {
    if (output.status !== 'ok') continue;
    const id = cameraKey(output.path);
    const current = byCamera.get(id);
    if (current) {
      if (time.wallClockMs < current.start.wallClockMs) current.start = time;
      if (time.wallClockMs > current.end.wallClockMs) current.end = time;
      current.timestampIssues ||= time.clockStatus !== 'ok';
    } else {
      byCamera.set(id, {
        id,
        start: time,
        end: time,
        timestampIssues: time.clockStatus !== 'ok',
      });
    }
  }
  return [...byCamera.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function deploymentRows(input: CamtrapDpInput): Row[] {
  const cameras = deployments(input.results);
  const missing = cameras.filter(({ id }) => {
    const location = input.locations?.[id];
    return (
      location === undefined ||
      !Number.isFinite(location.latitude) ||
      Math.abs(location.latitude) > 90 ||
      !Number.isFinite(location.longitude) ||
      Math.abs(location.longitude) > 180
    );
  });
  if (missing.length > 0) {
    throw new Error(
      `Camtrap DP requires valid WGS84 latitude and longitude for deployments: ${missing.map(({ id }) => id).join(', ')}. Export is blocked until coordinates are entered for each deployment.`,
    );
  }
  return cameras.map((deployment) => {
    const location = input.locations?.[deployment.id];
    return [
      deployment.id,
      location?.locationID ?? null,
      location?.locationName ?? null,
      location?.latitude ?? null,
      location?.longitude ?? null,
      location?.coordinateUncertainty ?? null,
      iso(deployment.start),
      iso(deployment.end),
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      deployment.timestampIssues,
      null,
      null,
      null,
      null,
      null,
      null,
    ];
  });
}

function mediaRows(results: readonly StoredResult[]): Row[] {
  return results
    .filter(({ output }) => output.status === 'ok')
    .map(({ output, time }) => ({ output, time }))
    .toSorted((a, b) =>
      a.output.path < b.output.path ? -1 : a.output.path > b.output.path ? 1 : 0,
    )
    .map(({ output, time }) => [
      output.path,
      cameraKey(output.path),
      'activityDetection',
      iso(time),
      output.path,
      false,
      output.path.split('/').at(-1) ?? output.path,
      mediaType(output.path),
      null,
      null,
      null,
    ]);
}

function observationRows(input: CamtrapDpInput): Row[] {
  const corrections = input.corrections ?? {};
  const ordered = input.events.toSorted((a, b) => {
    const difference = eventStart(a) - eventStart(b);
    return difference || (a.cameraKey < b.cameraKey ? -1 : a.cameraKey > b.cameraKey ? 1 : 0);
  });
  const rows: Row[] = [];
  for (const event of ordered) {
    const id = eventId(event);
    const first = event.photos[0];
    const last = event.photos.at(-1);
    const correctedEvent = correctedEvents([event], corrections)[0];
    if (correctedEvent === undefined) continue;
    const labels = new Set(correctedEvent.species.map(({ label }) => label));
    for (const photo of correctedEvent.photos) {
      for (const detection of photo.detections) {
        const label = detection.processed_classification?.class;
        if (label !== undefined && observationType(label) !== 'animal') labels.add(label);
      }
    }
    if (correctedEvent.photos.every((photo) => photo.detections.length === 0)) labels.add('blank');
    for (const label of labels) {
      const type = observationType(label);
      const count =
        type === 'animal'
          ? maxN(correctedEvent, label)
          : type === 'human' || type === 'vehicle'
            ? Math.max(
                ...correctedEvent.photos.map(
                  (photo) =>
                    photo.detections.filter(
                      (detection) => detection.processed_classification?.class === label,
                    ).length,
                ),
              )
            : null;
      const originals = event.species.filter(
        (species) => corrections[correctionKey(id, species.label)] === label,
      );
      const corrected = originals.length > 0;
      rows.push([
        `${id}:${labelParts(label)[0] || label}`,
        event.cameraKey,
        null,
        id,
        first ? iso(first.time) : null,
        last ? iso(last.time) : null,
        'event',
        type,
        null,
        type === 'animal' ? scientificName(label) : null,
        count,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        corrected ? 'human' : 'machine',
        corrected ? 'Human correction' : CLASSIFIED_BY,
        null,
        corrected ? null : labelScore(event, label),
        null,
        corrected
          ? originals
              .map(
                ({ label: original }) =>
                  `Machine label: ${original}; score: ${labelScore(event, original)}`,
              )
              .join(' | ')
          : null,
      ]);
    }
  }
  return rows;
}

function datapackage(input: CamtrapDpInput): string {
  if (input.project === undefined) {
    throw new Error(
      'Camtrap DP requires a project title and sampling design, and whether individual animals are recognized.',
    );
  }
  if (!input.contributors?.length) {
    throw new Error('Camtrap DP requires at least one contributor name.');
  }
  const cameras = deployments(input.results);
  if (cameras.length === 0) throw new Error('Camtrap DP requires at least one successful photo.');
  const times = cameras.flatMap(({ start, end }) => [start.wallClockMs, end.wallClockMs]);
  const taxa = correctedEvents(input.events, input.corrections ?? {})
    .flatMap(({ species }) => species.map(({ label }) => scientificName(label)))
    .filter(Boolean);
  return `${JSON.stringify(
    {
      profile: CAMTRAP_DP_PROFILE_URL,
      $schema: CAMTRAP_DP_PROFILE_URL,
      name: 'deerdiary-camtrap-dp',
      title: input.title ?? 'Deerdiary camera trap export',
      created: input.created,
      version: CAMTRAP_DP_VERSION,
      contributors: input.contributors,
      project: {
        ...input.project,
        captureMethod: ['activityDetection'],
        observationLevel: ['event'],
      },
      spatial: {
        type: 'MultiPoint',
        coordinates: cameras.map(({ id }) => {
          const location = input.locations?.[id];
          return [location?.longitude, location?.latitude];
        }),
      },
      temporal: {
        start: new Date(Math.min(...times)).toISOString().slice(0, 10),
        end: new Date(Math.max(...times)).toISOString().slice(0, 10),
      },
      taxonomic: [...new Set(taxa)].sort().map((scientificName) => ({ scientificName })),
      resources: [
        {
          name: 'deployments',
          path: 'deployments.csv',
          profile: 'tabular-data-resource',
          format: 'csv',
          mediatype: 'text/csv',
          encoding: 'utf-8',
          schema: `${SCHEMA_BASE}/deployments-table-schema.json`,
        },
        {
          name: 'media',
          path: 'media.csv',
          profile: 'tabular-data-resource',
          format: 'csv',
          mediatype: 'text/csv',
          encoding: 'utf-8',
          schema: `${SCHEMA_BASE}/media-table-schema.json`,
        },
        {
          name: 'observations',
          path: 'observations.csv',
          profile: 'tabular-data-resource',
          format: 'csv',
          mediatype: 'text/csv',
          encoding: 'utf-8',
          schema: `${SCHEMA_BASE}/observations-table-schema.json`,
        },
      ],
    },
    null,
    2,
  )}\n`;
}

/**
 * Writes one deployment per camera key, every successful photo as media, and event-based
 * observations so DCF rollover cannot split a deployment or duplicate an event.
 */
export function toCamtrapDp(input: CamtrapDpInput): CamtrapDpFiles {
  const rows = deploymentRows(input);
  return {
    datapackage: datapackage(input),
    deployments: table(DEPLOYMENT_COLUMNS, rows),
    media: table(MEDIA_COLUMNS, mediaRows(input.results)),
    observations: table(OBSERVATION_COLUMNS, observationRows(input)),
  };
}
