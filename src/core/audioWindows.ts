export const AUDIO_SAMPLE_RATE = 32_000;
export const AUDIO_WINDOW_SAMPLES = 5 * AUDIO_SAMPLE_RATE;
export const AUDIO_MIN_TAIL_SAMPLES = 2.5 * AUDIO_SAMPLE_RATE;
export const AUDIO_TARGET_PEAK = 0.25;

/** Non-overlapping windows; a final partial window is zero-padded when it holds at least 2.5 s, else dropped. */
export function windows(mono32k: Float32Array, hopSamples = AUDIO_WINDOW_SAMPLES): Float32Array[] {
  if (!Number.isSafeInteger(hopSamples) || hopSamples <= 0)
    throw new Error('Hop must be a positive integer number of samples');
  const out: Float32Array[] = [];
  for (let start = 0; start < mono32k.length; start += hopSamples) {
    const end = start + hopSamples;
    if (end > mono32k.length && mono32k.length - start < AUDIO_MIN_TAIL_SAMPLES) break;
    const w = new Float32Array(hopSamples);
    w.set(mono32k.subarray(start, end));
    out.push(w);
  }
  return out;
}

/** Copy with the mean removed and the peak scaled to 0.25; an all-constant window stays silent. */
export function normalise(w: Float32Array): Float32Array {
  const out = new Float32Array(w.length);
  if (w.length === 0) return out;
  let sum = 0;
  for (const v of w) sum += v;
  const mean = sum / w.length;
  let peak = 0;
  for (let i = 0; i < w.length; i++) {
    const v = (w[i] ?? 0) - mean;
    out[i] = v;
    peak = Math.max(peak, Math.abs(v));
  }
  if (peak === 0) return out;
  const gain = AUDIO_TARGET_PEAK / peak;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) * gain;
  return out;
}
