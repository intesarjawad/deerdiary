import { afterEach, expect, test, vi } from 'vitest';
import {
  AUDIO_MAX_BYTES,
  analyseAudio,
  audioMothWallClockMs,
  audioTime,
  cardCandidates,
  decodeAudioFile,
  mixToMono,
  parsePerchLabels,
  softmaxTop,
  tooLargeMessage,
  type WindowTop,
} from '../../src/files/audio';
import type { ScannedFile } from '../../src/files/scan';

afterEach(() => {
  vi.unstubAllGlobals();
});

const labels = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
const scanned = (name: string, mtimeMs: number): ScannedFile => ({
  path: name,
  name,
  kind: 'audio',
  ext: 'wav',
  sizeBytes: 1,
  mtimeMs,
  source: new File([], name),
});

test('channels are averaged and a single channel is copied', () => {
  expect([...mixToMono([Float32Array.from([1, 3]), Float32Array.from([3, 5])])]).toEqual([2, 4]);
  const mono = Float32Array.from([0.25, -0.5]);
  const copy = mixToMono([mono]);
  expect([...copy]).toEqual([0.25, -0.5]);
  expect(copy).not.toBe(mono);
});

test('missing or ragged channels are rejected', () => {
  expect(() => mixToMono([])).toThrow('no channels');
  expect(() => mixToMono([new Float32Array(2), new Float32Array(3)])).toThrow('differ');
});

test('an AudioMoth name gives its wall clock', () => {
  expect(audioMothWallClockMs('20260314_053000.WAV')).toBe(Date.UTC(2026, 2, 14, 5, 30, 0));
  expect(audioMothWallClockMs('20261231_235959.wav')).toBe(Date.UTC(2026, 11, 31, 23, 59, 59));
});

test.each([
  'recording.wav',
  '20260314053000.wav',
  '20260230_000000.wav',
  '20260314_250000.wav',
  '20260314_053000',
])('%s is not an AudioMoth name', (name) => {
  expect(audioMothWallClockMs(name)).toBeNull();
});

test('the file name wins over the modification time', () => {
  const drop = Date.UTC(2026, 5, 1);
  expect(audioTime(scanned('20260314_053000.WAV', Date.UTC(2026, 0, 15, 12)), drop)).toEqual({
    wallClockMs: Date.UTC(2026, 2, 14, 5, 30, 0),
    wallClockHour: 5,
    timeSource: 'name',
    offsetTimeOriginal: null,
    clockStatus: 'ok',
  });
});

test('without a camera name the modification time is read as the viewer wall clock', () => {
  // New York is five hours behind UTC in January, so noon UTC reads 07:00 there.
  const time = audioTime(scanned('call.mp3', Date.UTC(2026, 0, 15, 12)), Date.UTC(2026, 5, 1));
  expect(time.wallClockMs).toBe(Date.UTC(2026, 0, 15, 7));
  expect(time.wallClockHour).toBe(7);
  expect(time.timeSource).toBe('file');
});

test('a named time from before 2010 is a suspect clock', () => {
  const time = audioTime(scanned('20090101_000000.WAV', 0), Date.UTC(2026, 5, 1));
  expect(time.clockStatus).toBe('suspect');
});

test('the size message names the file and both sizes in whole megabytes', () => {
  expect(tooLargeMessage('big.wav', 300 * 1024 * 1024)).toBe(
    'big.wav is 300 MB, over the 200 MB limit for audio files, so it was not read.',
  );
});

test('a file over the limit is refused before any decoding starts', async () => {
  const context = vi.fn();
  vi.stubGlobal('OfflineAudioContext', context);
  const file = new File([], 'big.wav');
  Object.defineProperty(file, 'size', { value: AUDIO_MAX_BYTES + 1 });
  const result = await decodeAudioFile(file);
  expect(result.status).toBe('too_large');
  expect(context).not.toHaveBeenCalled();
});

test('decoding asks for a 32 kHz mono context and averages the decoded channels', async () => {
  const constructed: unknown[] = [];
  vi.stubGlobal(
    'OfflineAudioContext',
    class {
      constructor(options: unknown) {
        constructed.push(options);
      }
      async decodeAudioData() {
        const channels = [Float32Array.from([1, 0, -1]), Float32Array.from([0, 1, -1])];
        return { numberOfChannels: 2, getChannelData: (index: number) => channels[index] };
      }
    },
  );
  const result = await decodeAudioFile(new File([new Uint8Array(4)], 'call.wav'));
  expect(constructed).toEqual([{ sampleRate: 32_000, length: 1, numberOfChannels: 1 }]);
  expect(result).toEqual({ status: 'ok', samples: Float32Array.from([0.5, 0.5, -1]) });
});

test('a file the browser cannot decode is reported, not thrown', async () => {
  vi.stubGlobal(
    'OfflineAudioContext',
    class {
      async decodeAudioData() {
        throw new Error('EncodingError');
      }
    },
  );
  expect(await decodeAudioFile(new File([new Uint8Array(4)], 'bad.wav'))).toEqual({
    status: 'decode_failed',
  });
});

test('softmax ranks the five most likely labels, ties by index', () => {
  // exp(logits) = 6, 3, 1, 1, 1, 1, 1 with total 14.
  const logits = Float32Array.from([Math.log(6), Math.log(3), 0, 0, 0, 0, 0]);
  const top = softmaxTop(logits, labels);
  expect(top.map((guess) => guess.label)).toEqual(['a', 'b', 'c', 'd', 'e']);
  expect(top[0]?.prob).toBeCloseTo(6 / 14, 5);
  expect(top[1]?.prob).toBeCloseTo(3 / 14, 5);
  expect(top[4]?.prob).toBeCloseTo(1 / 14, 5);
});

test('softmax stays finite for large logits', () => {
  const top = softmaxTop(Float32Array.from([1000, 1000, 0, 0, 0, 0, 0]), labels);
  expect(top[0]?.prob).toBe(0.5);
  expect(top[1]?.prob).toBe(0.5);
});

test('softmax rejects non-finite logits and a label list of another length', () => {
  expect(() => softmaxTop(Float32Array.from([0, 0, 0, 0, 0, 0, Number.NaN]), labels)).toThrow(
    'finite',
  );
  expect(() => softmaxTop(new Float32Array(6), labels)).toThrow('finite');
});

const top = (window: number, ...guesses: [string, number][]): WindowTop => ({
  window,
  top: guesses.map(([label, prob]) => ({ label, prob })),
});

test('a card needs the probability floor in at least two windows', () => {
  const cards = cardCandidates([
    top(0, ['A', 0.5], ['B', 0.45]),
    top(1, ['A', 0.4], ['B', 0.3]),
    top(2, ['A', 0.1], ['C', 0.9]),
  ]);
  expect(cards).toEqual([
    { label: 'A', windows: 2, bestWindow: 0, bestProb: 0.5 },
    { label: 'B', windows: 2, bestWindow: 0, bestProb: 0.45 },
  ]);
});

test('two species near 0.5 each both earn cards, and exactly 0.25 counts', () => {
  const cards = cardCandidates([
    top(0, ['A', 0.5], ['B', 0.5]),
    top(1, ['A', 0.5], ['B', 0.5]),
    top(2, ['D', 0.25], ['E', 0.2499]),
    top(3, ['D', 0.25], ['E', 0.2499]),
  ]);
  expect(cards.map((card) => card.label)).toEqual(['A', 'B', 'D']);
});

test('cards run from the most windows to the fewest, then the strongest', () => {
  const cards = cardCandidates([
    top(0, ['A', 0.9], ['F', 0.3], ['G', 0.4]),
    top(1, ['A', 0.9], ['F', 0.3], ['G', 0.5]),
    top(2, ['F', 0.3]),
  ]);
  expect(cards.map((card) => [card.label, card.windows])).toEqual([
    ['F', 3],
    ['A', 2],
    ['G', 2],
  ]);
});

test('the strongest window plays, and the first of equal windows wins', () => {
  const cards = cardCandidates([
    top(0, ['A', 0.4]),
    top(1, ['A', 0.8]),
    top(2, ['A', 0.8]),
    top(3, ['A', 0.6]),
  ]);
  expect(cards[0]).toEqual({ label: 'A', windows: 4, bestWindow: 1, bestProb: 0.8 });
});

test('analysis scores each normalised window and plays the strongest raw window', async () => {
  // Ten seconds hold two windows: the first at 0.25, the second at 0.5.
  const samples = new Float32Array(320_000);
  samples.fill(0.25, 0, 160_000);
  samples.fill(0.5, 160_000);
  const inputs: Float32Array[] = [];
  const infer = async (window: Float32Array) => {
    inputs.push(window);
    return Float32Array.from([inputs.length === 1 ? 10 : 12, 0, 0, 0, 0, 0, 0]);
  };
  const result = await analyseAudio(samples, labels, infer);
  expect(result.windowCount).toBe(2);
  expect(inputs).toHaveLength(2);
  // A constant window has no signal once its offset is removed.
  expect(inputs.every((input) => input.length === 160_000 && input.every((v) => v === 0))).toBe(
    true,
  );
  expect(result.cards).toHaveLength(1);
  const card = result.cards[0];
  expect(card?.label).toBe('a');
  expect(card?.windows).toBe(2);
  expect(card?.bestWindow).toBe(1);
  expect(card?.wav).toHaveLength(320_044);
  // 0.5 rounds to 16384 = 0x4000, little-endian, at the first data sample.
  expect([...(card?.wav.subarray(44, 46) ?? [])]).toEqual([0x00, 0x40]);
});

test('a recording shorter than half a window has no windows and no cards', async () => {
  const infer = vi.fn(async () => new Float32Array(7));
  expect(await analyseAudio(new Float32Array(10_000), labels, infer)).toEqual({
    windowCount: 0,
    tops: [],
    cards: [],
  });
  expect(infer).not.toHaveBeenCalled();
});

test('the labels file drops its set name and a trailing newline', () => {
  expect(parsePerchLabels('set_name\nAnas acuta\nBass_drum\n')).toEqual([
    'Anas acuta',
    'Bass_drum',
  ]);
  expect(parsePerchLabels('set_name\r\nAnas acuta\r\n')).toEqual(['Anas acuta']);
});
