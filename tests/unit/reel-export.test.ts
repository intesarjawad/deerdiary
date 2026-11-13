import { expect, test, vi } from 'vitest';
import {
  createReelExporter,
  detectReelEncoding,
  REEL_H264_CODEC,
  REEL_UNSUPPORTED_MESSAGE,
  type ReelEncoding,
  type ReelExporterOptions,
  reelFileName,
} from '../../src/app/reelExport';

function videoEncoder(answer: boolean | Error) {
  return {
    isConfigSupported: vi.fn(async (config: VideoEncoderConfig) => {
      if (answer instanceof Error) throw answer;
      return { supported: answer, config };
    }),
  };
}

function mediaRecorder(types: readonly string[]) {
  return { isTypeSupported: (type: string) => types.includes(type) };
}

const request = {
  paths: ['cam/deer.jpg', 'cam/fox.jpg'],
  endCard: { title: 'Deerdiary', lines: ['white-tailed deer: 2 independent detections'] },
};

function exporter(overrides: Partial<ReelExporterOptions> = {}) {
  const saved: { name: string; blob: Blob }[] = [];
  const options: ReelExporterOptions = {
    loadPhoto: vi.fn(async (path: string) => new Blob([path], { type: 'image/jpeg' })),
    save: (file) => saved.push(file),
    detect: async () => ({ kind: 'webcodecs' }),
    encode: vi.fn(async () => new Blob(['mp4'], { type: 'video/mp4' })),
    ...overrides,
  };
  return { options, saved, reel: createReelExporter(options) };
}

test('prefers H.264 through WebCodecs at 1280 by 720', async () => {
  const encoder = videoEncoder(true);

  expect(await detectReelEncoding({ VideoEncoder: encoder })).toEqual({ kind: 'webcodecs' });
  expect(REEL_H264_CODEC).toBe('avc1.640028');
  expect(encoder.isConfigSupported).toHaveBeenCalledWith({
    codec: 'avc1.640028',
    width: 1280,
    height: 720,
  });
});

test('falls back to the first container MediaRecorder can write', async () => {
  expect(
    await detectReelEncoding({
      VideoEncoder: videoEncoder(false),
      MediaRecorder: mediaRecorder(['video/mp4', 'video/webm', 'video/webm;codecs=vp8']),
    }),
  ).toEqual({ kind: 'recorder', mimeType: 'video/webm;codecs=vp8' });
  expect(await detectReelEncoding({ MediaRecorder: mediaRecorder(['video/mp4']) })).toEqual({
    kind: 'recorder',
    mimeType: 'video/mp4',
  });
});

test('an engine that rejects the H.264 configuration records instead', async () => {
  expect(
    await detectReelEncoding({
      VideoEncoder: videoEncoder(new TypeError('Unsupported codec')),
      MediaRecorder: mediaRecorder(['video/webm;codecs=vp9']),
    }),
  ).toEqual({ kind: 'recorder', mimeType: 'video/webm;codecs=vp9' });
});

test('without H.264 or a usable MediaRecorder the export is unsupported', async () => {
  expect(await detectReelEncoding({})).toEqual({ kind: 'unsupported' });
  expect(
    await detectReelEncoding({
      VideoEncoder: videoEncoder(false),
      MediaRecorder: mediaRecorder(['video/x-matroska']),
    }),
  ).toEqual({ kind: 'unsupported' });
});

test.each<[ReelEncoding & { kind: 'webcodecs' | 'recorder' }, string]>([
  [{ kind: 'webcodecs' }, 'deerdiary-reel.mp4'],
  [{ kind: 'recorder', mimeType: 'video/webm;codecs=vp9' }, 'deerdiary-reel.webm'],
  [{ kind: 'recorder', mimeType: 'video/webm' }, 'deerdiary-reel.webm'],
  [{ kind: 'recorder', mimeType: 'video/mp4' }, 'deerdiary-reel.mp4'],
])('names the file after its container: %o', (encoding, name) => {
  expect(reelFileName(encoding)).toBe(name);
});

test('an unsupported browser gets the note and never loads a photo', async () => {
  const { options, reel } = exporter({ detect: async () => ({ kind: 'unsupported' }) });

  await reel.export(request);

  expect(reel.state.value).toEqual({ status: 'unsupported' });
  expect(REEL_UNSUPPORTED_MESSAGE).toBe('Reel export is not supported in this browser.');
  expect(options.loadPhoto).not.toHaveBeenCalled();
  expect(options.encode).not.toHaveBeenCalled();
});

test('exports the chosen photos, reports whole percents and saves the file', async () => {
  const states: unknown[] = [];
  const encode = vi.fn<NonNullable<ReelExporterOptions['encode']>>(
    async (_encoding, _video, onProgress) => {
      onProgress(0.001);
      onProgress(0.004);
      onProgress(0.5);
      onProgress(1);
      return new Blob(['mp4'], { type: 'video/mp4' });
    },
  );
  const { options, saved, reel } = exporter({ encode });
  expect(reel.state.value).toEqual({ status: 'checking' });
  reel.state.subscribe((state) => states.push(state));

  await reel.export(request);

  expect(options.loadPhoto).toHaveBeenCalledTimes(2);
  expect(vi.mocked(options.loadPhoto).mock.calls.map(([path]) => path)).toEqual(request.paths);
  const [encoding, video] = encode.mock.calls[0] ?? [];
  expect(encoding).toEqual({ kind: 'webcodecs' });
  expect(video?.photos).toHaveLength(2);
  expect(video?.endCard).toBe(request.endCard);
  expect(saved.map(({ name }) => name)).toEqual(['deerdiary-reel.mp4']);
  expect(states).toEqual([
    { status: 'checking' },
    { status: 'ready' },
    { status: 'exporting', percent: 0 },
    { status: 'exporting', percent: 50 },
    { status: 'exporting', percent: 100 },
    { status: 'ready' },
  ]);
});

test('a failed export says why and the next attempt starts again', async () => {
  const loadPhoto = vi
    .fn<ReelExporterOptions['loadPhoto']>()
    .mockRejectedValueOnce(new Error('cam/deer.jpg is no longer readable.'))
    .mockResolvedValue(new Blob(['jpeg']));
  const { saved, reel } = exporter({ loadPhoto });

  await reel.export(request);

  expect(reel.state.value).toEqual({
    status: 'failed',
    message:
      'Could not export the reel. cam/deer.jpg is no longer readable. Choose Export reel to try again.',
  });
  expect(saved).toEqual([]);

  await reel.export(request);

  expect(reel.state.value).toEqual({ status: 'ready' });
  expect(saved).toHaveLength(1);
});

test('an encoder failure that is not an Error is still reported', async () => {
  const { reel } = exporter({ encode: () => Promise.reject('encoder closed') });

  await reel.export(request);

  expect(reel.state.value).toEqual({
    status: 'failed',
    message: 'Could not export the reel. encoder closed Choose Export reel to try again.',
  });
});

test('a second request while one is encoding is ignored', async () => {
  let finish: (blob: Blob) => void = () => undefined;
  const encode = vi.fn(
    () =>
      new Promise<Blob>((resolve) => {
        finish = resolve;
      }),
  );
  const { saved, reel } = exporter({ encode });

  const first = reel.export(request);
  await vi.waitFor(() => expect(encode).toHaveBeenCalledTimes(1));
  await reel.export(request);
  finish(new Blob(['mp4']));
  await first;

  expect(encode).toHaveBeenCalledTimes(1);
  expect(saved).toHaveLength(1);
});
