import {
  AUDIO_SAMPLE_RATE,
  AUDIO_WINDOW_SAMPLES,
  windows as cutWindows,
  normalise,
} from '../core/audioWindows';
import { type CameraTime, clockStatus, fileWallClockMs, parseExifWallClockMs } from '../core/time';
import { encodeWav16 } from '../core/wav';
import type { ScannedFile } from './scan';

export const AUDIO_MAX_BYTES = 200 * 1024 * 1024;
export const AUDIO_TOP_K = 5;
// Perch 2.0 trains its softmax head on multi-hot targets normalised to 1/k (arXiv 2508.04665), so two
// species calling together each top out near 0.5 and a 0.5 rule would drop both.
export const AUDIO_CARD_MIN_PROB = 0.25;
export const AUDIO_CARD_MIN_WINDOWS = 2;

export type AudioTime = Omit<CameraTime, 'timeSource'> & { timeSource: 'name' | 'file' };
export type WindowGuess = { label: string; prob: number };
export type WindowTop = { window: number; top: readonly WindowGuess[] };
export type AudioCard = {
  label: string;
  /** Windows where the species reached the probability floor. */
  windows: number;
  bestWindow: number;
  bestProb: number;
  wav: Uint8Array<ArrayBuffer>;
};
export type AudioDecode =
  | { status: 'ok'; samples: Float32Array }
  | { status: 'too_large'; message: string }
  | { status: 'decode_failed' };

export function tooLargeMessage(name: string, sizeBytes: number): string {
  const megabytes = Math.round(sizeBytes / (1024 * 1024));
  return `${name} is ${megabytes} MB, over the ${AUDIO_MAX_BYTES / (1024 * 1024)} MB limit for audio files, so it was not read.`;
}

/** Averages equal-length channels into one; a single channel is copied. */
export function mixToMono(channels: readonly Float32Array[]): Float32Array {
  const first = channels[0];
  if (!first) throw new Error('Audio has no channels');
  if (channels.some((channel) => channel.length !== first.length))
    throw new Error('Audio channels differ in length');
  const out = new Float32Array(first.length);
  for (const channel of channels) {
    for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) + (channel[i] ?? 0);
  }
  if (channels.length > 1) {
    for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) / channels.length;
  }
  return out;
}

/** Decodes on the main thread because dedicated workers have no audio contexts. */
export async function decodeAudioFile(file: File): Promise<AudioDecode> {
  if (file.size > AUDIO_MAX_BYTES)
    return { status: 'too_large', message: tooLargeMessage(file.name, file.size) };
  try {
    // The context's own rate makes decodeAudioData resample the file to 32 kHz.
    const context = new OfflineAudioContext({
      sampleRate: AUDIO_SAMPLE_RATE,
      length: 1,
      numberOfChannels: 1,
    });
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) =>
      buffer.getChannelData(index),
    );
    return { status: 'ok', samples: mixToMono(channels) };
  } catch {
    return { status: 'decode_failed' };
  }
}

/** Reads the wall clock from an AudioMoth name such as 20260314_053000.WAV; anything else is null. */
export function audioMothWallClockMs(name: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.[^.]+$/.exec(name);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return parseExifWallClockMs(`${year}:${month}:${day} ${hour}:${minute}:${second}`);
}

/** An AudioMoth name wins over the file's own modification time. */
export function audioTime(scanned: ScannedFile, dropWallClockMs: number): AudioTime {
  const named = audioMothWallClockMs(scanned.name);
  const wallClockMs = named ?? fileWallClockMs(scanned.mtimeMs);
  return {
    wallClockMs,
    wallClockHour: new Date(wallClockMs).getUTCHours(),
    timeSource: named === null ? 'file' : 'name',
    offsetTimeOriginal: null,
    clockStatus: clockStatus(wallClockMs, dropWallClockMs),
  };
}

/** Softmax over logits, then the `k` most likely entries, most likely first. */
export function softmaxTop(
  logits: Float32Array,
  labels: readonly string[],
  k = AUDIO_TOP_K,
): WindowGuess[] {
  if (logits.length !== labels.length || labels.length < k || !logits.every(Number.isFinite))
    throw new Error('Expected finite Perch logits matching the label list');
  let maximum = -Infinity;
  for (const value of logits) maximum = Math.max(maximum, value);
  let sum = 0;
  const exps = new Float64Array(logits.length);
  for (let i = 0; i < logits.length; i++) {
    const e = Math.exp((logits[i] ?? 0) - maximum);
    exps[i] = e;
    sum += e;
  }
  const ranked = Array.from(exps.keys()).sort((a, b) => (exps[b] ?? 0) - (exps[a] ?? 0) || a - b);
  return ranked.slice(0, k).map((index) => ({
    label: labels[index] ?? '',
    prob: (exps[index] ?? 0) / sum,
  }));
}

type CardDraft = { label: string; windows: number; bestWindow: number; bestProb: number };

/** A species earns a card at the probability floor in at least two windows; the loudest window plays. */
export function cardCandidates(
  tops: readonly WindowTop[],
  minProb = AUDIO_CARD_MIN_PROB,
  minWindows = AUDIO_CARD_MIN_WINDOWS,
): Omit<AudioCard, 'wav'>[] {
  const drafts = new Map<string, CardDraft>();
  for (const { window, top } of tops) {
    for (const { label, prob } of top) {
      if (prob < minProb) continue;
      const draft = drafts.get(label);
      if (!draft) drafts.set(label, { label, windows: 1, bestWindow: window, bestProb: prob });
      else {
        draft.windows++;
        if (prob > draft.bestProb) {
          draft.bestProb = prob;
          draft.bestWindow = window;
        }
      }
    }
  }
  return Array.from(drafts.values())
    .filter((draft) => draft.windows >= minWindows)
    .sort(
      (a, b) => b.windows - a.windows || b.bestProb - a.bestProb || a.label.localeCompare(b.label),
    );
}

export type AudioAnalysis = { windowCount: number; tops: WindowTop[]; cards: AudioCard[] };

/** Runs `infer` on each normalised five-second window and builds the species cards. */
export async function analyseAudio(
  samples: Float32Array,
  labels: readonly string[],
  infer: (window: Float32Array) => Promise<Float32Array>,
): Promise<AudioAnalysis> {
  const cut = cutWindows(samples);
  const tops: WindowTop[] = [];
  for (const [window, raw] of cut.entries()) {
    tops.push({ window, top: softmaxTop(await infer(normalise(raw)), labels) });
  }
  const cards = cardCandidates(tops).map((card) => ({
    ...card,
    wav: encodeWav16(
      cut[card.bestWindow] ?? new Float32Array(AUDIO_WINDOW_SAMPLES),
      AUDIO_SAMPLE_RATE,
    ),
  }));
  return { windowCount: cut.length, tops, cards };
}

/** The labels file is a one-line set name followed by one species or sound per line. */
export function parsePerchLabels(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(1);
}
