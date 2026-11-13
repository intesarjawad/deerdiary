import { expect, test } from 'vitest';
import { normalise, windows } from '../../src/core/audioWindows';

const rate = 32_000;
const seconds = (s: number) => Math.round(s * rate);
const ramp = (n: number) => Float32Array.from({ length: n }, (_, i) => (i % 100) / 100);

test('silence of 5 s is one silent window', () => {
  const out = windows(new Float32Array(seconds(5)));
  expect(out).toHaveLength(1);
  expect(out[0]).toHaveLength(160_000);
  expect(out[0]?.every((v) => v === 0)).toBe(true);
});

test('empty input has no windows', () => {
  expect(windows(new Float32Array(0))).toEqual([]);
});

test('a 7.4 s signal drops its 2.4 s tail', () => {
  const signal = ramp(seconds(7.4));
  const out = windows(signal);
  expect(out).toHaveLength(1);
  expect(out[0]).toEqual(signal.subarray(0, 160_000));
});

test('a 2.4 s signal has no window', () => {
  expect(windows(ramp(seconds(2.4)))).toEqual([]);
});

test('a 2.5 s tail is kept and zero-padded', () => {
  const signal = Float32Array.from({ length: seconds(7.5) }, () => 1);
  const out = windows(signal);
  expect(out).toHaveLength(2);
  const tail = out[1] as Float32Array;
  expect(tail).toHaveLength(160_000);
  expect(tail.subarray(0, 80_000).every((v) => v === 1)).toBe(true);
  expect(tail.subarray(80_000).every((v) => v === 0)).toBe(true);
});

test('windows do not overlap and follow a custom hop', () => {
  const signal = Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(windows(signal, 4).map((w) => [...w])).toEqual([
    [0, 1, 2, 3],
    [4, 5, 6, 7],
  ]);
});

test('a non-positive hop is rejected', () => {
  expect(() => windows(new Float32Array(10), 0)).toThrow('Hop');
  expect(() => windows(new Float32Array(10), 1.5)).toThrow('Hop');
});

test('normalise leaves silence silent', () => {
  const out = normalise(new Float32Array(100));
  expect(out.every((v) => v === 0)).toBe(true);
});

test('normalise removes a pure DC offset without dividing by zero', () => {
  const out = normalise(new Float32Array(100).fill(0.5));
  expect(out.every((v) => v === 0)).toBe(true);
});

test('normalise removes DC and scales the peak to 0.25', () => {
  // Mean 0.3 leaves +-0.2, which is then scaled up to +-0.25.
  const out = normalise(Float32Array.from([0.5, 0.1, 0.5, 0.1]));
  expect([...out]).toEqual([0.25, -0.25, 0.25, -0.25].map(Math.fround));
});

test('normalise brings a clipped signal down to 0.25', () => {
  const out = normalise(Float32Array.from([1, -1, 1, -1]));
  expect([...out]).toEqual([0.25, -0.25, 0.25, -0.25]);
});

test('normalise does not modify its input', () => {
  const input = Float32Array.from([2, 0]);
  const out = normalise(input);
  expect([...input]).toEqual([2, 0]);
  expect([...out]).toEqual([0.25, -0.25]);
});
