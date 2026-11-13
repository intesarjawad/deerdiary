const HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2;
const MAX_DATA_BYTES = 0xffff_ffff - (HEADER_BYTES - 8);

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** Mono 16-bit PCM WAV; samples outside [-1, 1] are clipped and NaN becomes silence. */
export function encodeWav16(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0)
    throw new Error('Sample rate must be a positive integer');
  const dataBytes = samples.length * BYTES_PER_SAMPLE;
  if (dataBytes > MAX_DATA_BYTES) throw new Error('Audio is too long for a WAV file');
  const bytes = new Uint8Array(HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, HEADER_BYTES - 8 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true);
  view.setUint16(32, BYTES_PER_SAMPLE, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i] ?? 0;
    const clipped = Number.isNaN(value) ? 0 : Math.max(-1, Math.min(1, value));
    view.setInt16(
      HEADER_BYTES + i * BYTES_PER_SAMPLE,
      Math.round(clipped * (clipped < 0 ? 32768 : 32767)),
      true,
    );
  }
  return bytes;
}
