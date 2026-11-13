import { expect, test } from 'vitest';
import { encodeWav16 } from '../../src/core/wav';

const text = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

test('six samples encode to a 44-byte header and little-endian 16-bit data', () => {
  // Full scale maps to +-32767/32768, 0.5 rounds up, and out-of-range or NaN input cannot wrap.
  const wav = encodeWav16(Float32Array.from([0, 1, -1, 0.5, 2, Number.NaN]), 32_000);
  expect([...wav]).toEqual([
    ...[0x52, 0x49, 0x46, 0x46],
    ...[0x30, 0, 0, 0],
    ...[0x57, 0x41, 0x56, 0x45],
    ...[0x66, 0x6d, 0x74, 0x20],
    ...[0x10, 0, 0, 0],
    ...[1, 0],
    ...[1, 0],
    ...[0x00, 0x7d, 0, 0],
    ...[0x00, 0xfa, 0, 0],
    ...[2, 0],
    ...[16, 0],
    ...[0x64, 0x61, 0x74, 0x61],
    ...[0x0c, 0, 0, 0],
    ...[0x00, 0x00],
    ...[0xff, 0x7f],
    ...[0x00, 0x80],
    ...[0x00, 0x40],
    ...[0xff, 0x7f],
    ...[0x00, 0x00],
  ]);
});

test('an empty clip is a valid header with no data', () => {
  const wav = encodeWav16(new Float32Array(0), 8_000);
  expect(wav).toHaveLength(44);
  expect(text(wav, 0, 4)).toBe('RIFF');
  expect(new DataView(wav.buffer).getUint32(4, true)).toBe(36);
  expect(new DataView(wav.buffer).getUint32(40, true)).toBe(0);
});

test('a five-second window at 32 kHz is 320044 bytes', () => {
  const wav = encodeWav16(new Float32Array(160_000), 32_000);
  expect(wav).toHaveLength(320_044);
  expect(new DataView(wav.buffer).getUint32(40, true)).toBe(320_000);
});

test('a non-positive or fractional sample rate is rejected', () => {
  expect(() => encodeWav16(new Float32Array(1), 0)).toThrow('Sample rate');
  expect(() => encodeWav16(new Float32Array(1), 44_100.5)).toThrow('Sample rate');
});
