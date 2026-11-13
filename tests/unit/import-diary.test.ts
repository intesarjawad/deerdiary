import { expect, test, vi } from 'vitest';
import { createDiaryImporter } from '../../src/app/importDiary';
import { SPECIESNET_FORMAT_VERSION } from '../../src/core/speciesnetJson';
import type { CameraTime } from '../../src/core/time';
import type { ScannedFile } from '../../src/files/scan';
import type { StoredResult } from '../../src/storage/schema';

const deer = 'deer-uuid;mammalia;artiodactyla;cervidae;odocoileus;virginianus;white-tailed deer';
const fox = 'fox-uuid;mammalia;carnivora;canidae;vulpes;vulpes;red fox';
const family = 'cervid-uuid;mammalia;artiodactyla;cervidae;;;';
const context = {
  taxonomyMap: { 'mammalia;artiodactyla;cervidae;;': family },
  geofenceMap: { 'mammalia;artiodactyla;cervidae;odocoileus;virginianus': { block: { GBR: [] } } },
};
const DROP_MS = Date.UTC(2026, 10, 1);

function detection(classes: readonly string[], scores: readonly number[], category = '1') {
  return {
    category,
    label: 'animal',
    conf: 0.9,
    bbox: [0, 0, 1, 1],
    raw_classifications: { classes, scores },
    processed_classification: { class: classes[0], score: scores[0], source: 'classifier' },
  };
}

function predictionsFile(predictions: unknown[]): File {
  const text = JSON.stringify({ info: { format_version: SPECIESNET_FORMAT_VERSION }, predictions });
  return new File([text], 'out.json', { type: 'application/json' });
}

function scanned(path: string, mtimeMs: number): ScannedFile {
  const name = path.split('/').at(-1) ?? path;
  return {
    path,
    name,
    kind: 'photo',
    ext: 'jpg',
    sizeBytes: 4,
    mtimeMs,
    source: new File(['jpeg'], name, { lastModified: mtimeMs }),
  };
}

function cameraTime(wallClockMs: number): CameraTime {
  return {
    wallClockMs,
    wallClockHour: new Date(wallClockMs).getUTCHours(),
    timeSource: 'exif',
    offsetTimeOriginal: null,
    clockStatus: 'ok',
  };
}

function setup() {
  const shown: { results: readonly StoredResult[]; corrections: Record<string, string> }[] = [];
  const ensembleContext = vi.fn(async () => context);
  const importer = createDiaryImporter({
    show: (results, corrections) => shown.push({ results, corrections: { ...corrections } }),
    ensembleContext,
    readTime: async (file) => cameraTime(file.mtimeMs),
  });
  return { importer, shown, ensembleContext };
}

function labels(results: readonly StoredResult[]): (string | undefined)[] {
  return results.flatMap(({ output }) =>
    output.status === 'ok'
      ? output.detections.map((entry) => entry.processed_classification?.class)
      : [],
  );
}

const twoClasses = predictionsFile([
  {
    filepath: '/home/me/card/DCIM/100MEDIA/a.jpg',
    detections: [detection([deer, fox], [0.9, 0.05])],
  },
  {
    filepath: '/home/me/card/DCIM/100MEDIA/b.jpg',
    detections: [detection([fox, deer], [0.8, 0.1])],
  },
]);
const fiveClasses = predictionsFile([
  {
    filepath: 'card/a.jpg',
    detections: [
      detection(
        [deer, fox, 'a;m;o;f;g;s;a', 'b;m;o;f;g;s;b', 'c;m;o;f;g;s;c'],
        [0.9, 0.03, 0.03, 0.02, 0.01],
      ),
    ],
  },
]);

test('waits for the photo folder, then shows each matched prediction at its camera time', async () => {
  const { importer, shown } = setup();

  await importer.read(twoClasses, [], DROP_MS);
  expect(importer.state.value).toEqual({ status: 'waiting', photoCount: 2 });
  expect(importer.needsFolder()).toBe(true);
  expect(shown).toEqual([]);

  await importer.attach(
    [scanned('card/DCIM/100MEDIA/b.jpg', 2_000), scanned('card/DCIM/100MEDIA/a.jpg', 1_000)],
    DROP_MS,
  );

  expect(importer.state.value).toEqual({
    status: 'shown',
    photoCount: 2,
    unmatchedCount: 0,
    countryFixed: true,
  });
  expect(importer.needsFolder()).toBe(false);
  const [{ results }] = shown as [(typeof shown)[number]];
  expect(results.map(({ key, time, output }) => [key, time.wallClockMs, output.path])).toEqual([
    ['card/DCIM/100MEDIA/a.jpg|4|1000', 1_000, 'card/DCIM/100MEDIA/a.jpg'],
    ['card/DCIM/100MEDIA/b.jpg|4|2000', 2_000, 'card/DCIM/100MEDIA/b.jpg'],
  ]);
  expect(labels(results)).toEqual([deer, fox]);
  const first = results[0]?.output;
  expect(first?.status === 'ok' && first.thumbnail.size).toBe(4);
});

test('a folder dropped before the file is matched as soon as the file is read', async () => {
  const { importer, shown } = setup();

  await importer.read(twoClasses, [scanned('x/DCIM/100MEDIA/a.jpg', 1_000)], DROP_MS);

  expect(importer.state.value).toEqual({
    status: 'shown',
    photoCount: 1,
    unmatchedCount: 1,
    countryFixed: true,
  });
  expect(shown).toHaveLength(1);
});

test('a folder that holds none of the listed photos keeps the file waiting for the right one', async () => {
  const { importer, shown } = setup();
  await importer.read(twoClasses, [], DROP_MS);

  await importer.attach([scanned('other/c.jpg', 1_000)], DROP_MS);

  expect(importer.state.value).toEqual({
    status: 'failed',
    message:
      'None of the 2 photos in the predictions file is in this folder. Drop the folder the predictions were made from.',
  });
  expect(importer.needsFolder()).toBe(true);
  await importer.attach([scanned('card/DCIM/100MEDIA/a.jpg', 1_000)], DROP_MS);
  expect(importer.state.value.status).toBe('shown');
  expect(shown).toHaveLength(1);
});

test('rejects malformed files with the first bad field and keeps no earlier file waiting', async () => {
  const { importer } = setup();
  await importer.read(twoClasses, [], DROP_MS);

  await importer.read(new File(['{"predictions":'], 'out.json'), [], DROP_MS);
  expect(importer.state.value).toEqual({
    status: 'failed',
    message:
      'This file is not valid JSON. Pick the predictions file written by SpeciesNet or MegaDetector.',
  });
  expect(importer.needsFolder()).toBe(false);

  await importer.read(
    predictionsFile([{ filepath: 'a.jpg', detections: [detection([deer], [0.9], 'bird')] }]),
    [],
    DROP_MS,
  );
  expect(importer.state.value).toEqual({
    status: 'failed',
    message:
      'This file could not be imported: "predictions[0].detections[0].category" is missing or has the wrong type.',
  });

  await importer.read(predictionsFile([]), [], DROP_MS);
  expect(importer.state.value).toEqual({
    status: 'failed',
    message: 'The predictions file lists no photos. Pick the file written for the photo folder.',
  });
});

test('a photo the pipeline could not read is kept as a failed photo', async () => {
  const { importer, shown } = setup();

  await importer.read(
    predictionsFile([{ filepath: 'a.jpg', failures: ['CLASSIFIER'], detections: [] }]),
    [scanned('a.jpg', 1_000)],
    DROP_MS,
  );

  expect(shown[0]?.results[0]?.output.status).toBe('decode_failed');
});

test('reports a photo whose time cannot be read and lets the next drop retry', async () => {
  const importer = createDiaryImporter({
    show: () => {},
    ensembleContext: async () => context,
    readTime: async () => {
      throw new Error('The file is gone.');
    },
  });

  await importer.read(twoClasses, [scanned('card/DCIM/100MEDIA/a.jpg', 1_000)], DROP_MS);

  expect(importer.state.value).toEqual({
    status: 'failed',
    message: 'Could not import the predictions. The file is gone. Drop the folder again to retry.',
  });
  expect(importer.needsFolder()).toBe(true);
});

test('a country change keeps labels from a file with fewer than five raw classes', async () => {
  const { importer, shown, ensembleContext } = setup();
  await importer.read(twoClasses, [scanned('card/DCIM/100MEDIA/a.jpg', 1_000)], DROP_MS);

  await importer.setCountry('GBR');

  expect(ensembleContext).not.toHaveBeenCalled();
  expect(shown).toHaveLength(1);
  expect(labels(shown[0]?.results ?? [])).toEqual([deer]);
});

test('a country change relabels a file with five raw classes from its original labels', async () => {
  const { importer, shown } = setup();
  await importer.read(fiveClasses, [scanned('card/a.jpg', 1_000)], DROP_MS);
  expect(importer.state.value).toMatchObject({ status: 'shown', countryFixed: false });

  await importer.setCountry('GBR');
  await importer.setCountry('USA');

  expect(shown.map(({ results }) => labels(results))).toEqual([[deer], [family], [deer]]);
});

test('after a reset a country change leaves the diary to the model run that replaced it', async () => {
  const { importer, shown } = setup();
  await importer.read(fiveClasses, [scanned('card/a.jpg', 1_000)], DROP_MS);

  importer.reset();
  await importer.setCountry('GBR');

  expect(importer.state.value).toEqual({ status: 'idle' });
  expect(importer.needsFolder()).toBe(false);
  expect(shown).toHaveLength(1);
});

test('leaves the labels alone when the models for a country change cannot load', async () => {
  const shown: StoredResult[][] = [];
  const importer = createDiaryImporter({
    show: (results) => shown.push([...results]),
    ensembleContext: async () => undefined,
    readTime: async (file) => cameraTime(file.mtimeMs),
  });
  await importer.read(fiveClasses, [scanned('card/a.jpg', 1_000)], DROP_MS);

  await importer.setCountry('GBR');

  expect(shown).toHaveLength(1);
});

test('passes the corrections saved in the file to the diary', async () => {
  const { importer, shown } = setup();
  const file = new File(
    [
      JSON.stringify({
        info: { format_version: SPECIESNET_FORMAT_VERSION },
        predictions: [{ filepath: 'a.jpg', detections: [] }],
        deerdiary: {
          version: 1,
          events: [],
          corrections: { k: fox },
          independence_interval_min: 30,
        },
      }),
    ],
    'export.json',
  );

  await importer.read(file, [scanned('a.jpg', 1_000)], DROP_MS);

  expect(shown[0]?.corrections).toEqual({ k: fox });
});
