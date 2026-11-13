import { expect, test, vi } from 'vitest';
import { createSampleLoader } from '../../src/app/sample';
import type { StoredResult } from '../../src/storage/schema';
import { exportSession } from '../../src/ui/History';
import { output, time } from './fixtures/pipeline';

const BASE = 'https://example.org/deerdiary/';

function sampleExport(): string {
  const photo = (path: string): StoredResult => ({
    key: `${path}|1|2`,
    time,
    output: output({ file: new File([], path), settings: { path } }),
  });
  const results = [photo('sample/a.jpg'), photo('sample/b.jpg')];
  const session = {
    id: 'sample',
    createdAtMs: 0,
    fileKeys: results.map(({ key }) => key),
    dateRange: null,
  };
  return exportSession(session, results, {}).text;
}

function server(files: Record<string, string>) {
  return vi.fn<typeof fetch>(async (input) => {
    const body = files[String(input).slice(BASE.length)];
    return body === undefined ? new Response('', { status: 404 }) : new Response(body);
  });
}

const served = () => ({
  'sample/predictions.json': sampleExport(),
  'sample/thumbs/a.jpg': 'preview a',
  'sample/thumbs/b.jpg': 'preview b',
  'sample/a.jpg': 'photo a',
  'sample/b.jpg': 'photo b',
});

test('shows the precomputed diary with its stored previews and fetches nothing else', async () => {
  const fetch = server(served());
  const show = vi.fn();
  const sample = createSampleLoader({ baseUrl: BASE, show, fetch });

  await sample.load();

  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
    `${BASE}sample/predictions.json`,
    `${BASE}sample/thumbs/a.jpg`,
    `${BASE}sample/thumbs/b.jpg`,
  ]);
  const [results] = show.mock.calls[0] ?? [];
  const previews = await Promise.all(
    (results as StoredResult[]).map(async ({ output }) =>
      output.status === 'ok' ? [output.path, await output.thumbnail.text()] : [],
    ),
  );
  expect(previews).toEqual([
    ['sample/a.jpg', 'preview a'],
    ['sample/b.jpg', 'preview b'],
  ]);
  expect(sample.state.value).toEqual({
    status: 'shown',
    photoPaths: ['sample/a.jpg', 'sample/b.jpg'],
  });
});

test('hands over the sample photos as a dropped folder for a run in this tab', async () => {
  const sample = createSampleLoader({ baseUrl: BASE, show: vi.fn(), fetch: server(served()) });
  await sample.load();

  const files = await sample.photos();

  expect(
    await Promise.all(
      (files ?? []).map(async ({ path, kind, source }) => [
        path,
        kind,
        await (await ('getFile' in source ? source.getFile() : source)).text(),
      ]),
    ),
  ).toEqual([
    ['sample/a.jpg', 'photo', 'photo a'],
    ['sample/b.jpg', 'photo', 'photo b'],
  ]);
  expect(sample.state.value).toEqual({ status: 'idle' });
});

test('a build without the sample says so and points to the user’s own card', async () => {
  const show = vi.fn();
  const sample = createSampleLoader({ baseUrl: BASE, show, fetch: server({}) });

  await sample.load();

  expect(show).not.toHaveBeenCalled();
  expect(sample.state.value).toEqual({
    status: 'failed',
    message:
      'This copy of the app was built without the sample. Drop your own card folder instead.',
  });
  expect(await sample.photos()).toBeUndefined();
});

test('a missing preview fails the sample instead of showing an incomplete diary', async () => {
  const { 'sample/thumbs/b.jpg': _missing, ...rest } = served();
  const show = vi.fn();
  const sample = createSampleLoader({ baseUrl: BASE, show, fetch: server(rest) });

  await sample.load();

  expect(show).not.toHaveBeenCalled();
  expect(sample.state.value.status).toBe('failed');
});

test('names the bad field of a damaged sample file', async () => {
  const sample = createSampleLoader({
    baseUrl: BASE,
    show: vi.fn(),
    fetch: server({ 'sample/predictions.json': '{"predictions": []}' }),
  });

  await sample.load();

  expect(sample.state.value).toEqual({
    status: 'failed',
    message:
      'Could not load the sample. The sample file has a bad "info" field. Reload the page, then press "Try the sample" again.',
  });
});

test('an unreachable server is reported as a connection problem', async () => {
  const sample = createSampleLoader({
    baseUrl: BASE,
    show: vi.fn(),
    fetch: vi.fn<typeof fetch>(async () => {
      throw new TypeError('Failed to fetch');
    }),
  });

  await sample.load();

  expect(sample.state.value).toEqual({
    status: 'failed',
    message:
      'Could not download the sample. Check the internet connection, then press "Try the sample" again.',
  });
});
