import { expect, test } from 'vitest';
import { aviFrameBlob, parseAvi } from '../../src/core/avi';
import { clockStatus } from '../../src/core/time';
import {
  containsHevcMarker,
  sampleSeconds,
  VIDEO_MAX_FRAMES,
  videoCameraTime,
} from '../../src/files/video';

const encoder = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function chunk(id: string, payload: Uint8Array): Uint8Array {
  return concat(
    encoder.encode(id),
    u32(payload.length),
    payload,
    new Uint8Array(payload.length & 1),
  );
}

function list(type: string, ...children: Uint8Array[]): Uint8Array {
  return chunk('LIST', concat(encoder.encode(type), ...children));
}

function fields(size: number, values: Record<number, number | string>): Uint8Array {
  const out = new Uint8Array(size);
  for (const [at, value] of Object.entries(values)) {
    out.set(typeof value === 'string' ? encoder.encode(value) : u32(value), Number(at));
  }
  return out;
}

type Built = { bytes: Uint8Array; frameStarts: number[] };

// Frame data begins 8 bytes after each chunk header; the layout is tallied here by hand.
function buildAvi(options: {
  handler?: string;
  microSecPerFrame?: number;
  frames: Uint8Array[];
  audioAfterFirst?: boolean;
  index?: 'relative' | 'absolute' | 'none';
}): Built {
  const { handler = 'MJPG', microSecPerFrame = 100_000, frames } = options;
  const hdrl = list(
    'hdrl',
    chunk('avih', fields(56, { 0: microSecPerFrame, 16: frames.length, 24: 2, 32: 64, 36: 48 })),
    list(
      'strl',
      chunk('strh', fields(56, { 0: 'vids', 4: handler, 20: 1, 24: 10 })),
      chunk('strf', new Uint8Array(40)),
    ),
    list(
      'strl',
      chunk('strh', fields(56, { 0: 'auds', 4: '\0\0\0\0', 20: 1, 24: 8000 })),
      chunk('strf', new Uint8Array(16)),
    ),
  );
  const entries: Uint8Array[] = [];
  const moviChildren: Uint8Array[] = [];
  const frameOffsets: number[] = [];
  // The movi type code is 4 bytes, so the first chunk header sits at offset 4.
  let offset = 4;
  const add = (id: string, payload: Uint8Array) => {
    const entry = chunk(id, payload);
    entries.push(concat(encoder.encode(id), u32(0x10), u32(offset), u32(payload.length)));
    if (id === '00dc') frameOffsets.push(offset);
    moviChildren.push(entry);
    offset += entry.length;
  };
  frames.forEach((frame, index) => {
    add('00dc', frame);
    if (index === 0 && options.audioAfterFirst) add('01wb', new Uint8Array([9, 9, 9]));
  });
  const movi = list('movi', ...moviChildren);
  const prefix = concat(encoder.encode('AVI '), hdrl);
  const moviStart = 12 + hdrl.length;
  const index = options.index ?? 'relative';
  const idx1 =
    index === 'none'
      ? new Uint8Array(0)
      : chunk(
          'idx1',
          concat(
            ...entries.map((entry) => {
              if (index === 'relative') return entry;
              const absolute = concat(entry);
              // moviStart + 8 is where the movi type code sits.
              absolute.set(u32(new DataView(entry.buffer).getUint32(8, true) + moviStart + 8), 8);
              return absolute;
            }),
          ),
        );
  const body = concat(prefix, movi, idx1);
  const bytes = concat(encoder.encode('RIFF'), u32(body.length), body);
  return { bytes, frameStarts: frameOffsets.map((at) => moviStart + 8 + at + 8) };
}

const frames = [
  new Uint8Array([0xff, 0xd8, 1, 1, 1, 0xff, 0xd9]),
  new Uint8Array([0xff, 0xd8, 2, 2, 0xff, 0xd9]),
  new Uint8Array([0xff, 0xd8, 3, 3, 3, 3, 3, 0xff, 0xd9]),
];

function frameBytes(bytes: Uint8Array, frame: { offset: number; length: number }): number[] {
  return Array.from(bytes.subarray(frame.offset, frame.offset + frame.length));
}

test('reads a 3-frame MJPEG file through its index', () => {
  const { bytes } = buildAvi({ frames });
  const clip = parseAvi(bytes);
  if (clip.status !== 'ok') throw new Error(clip.status);
  expect(clip.microSecPerFrame).toBe(100_000);
  expect(clip.handler).toBe('MJPG');
  expect([clip.width, clip.height]).toEqual([64, 48]);
  expect(clip.truncated).toBe(false);
  expect(clip.frames.map((frame) => frameBytes(bytes, frame))).toEqual(frames.map((f) => [...f]));
});

test('finds frames without an index and skips other streams', () => {
  const { bytes } = buildAvi({ frames, audioAfterFirst: true, index: 'none' });
  const clip = parseAvi(bytes);
  if (clip.status !== 'ok') throw new Error(clip.status);
  expect(clip.truncated).toBe(false);
  expect(clip.frames.map((frame) => frameBytes(bytes, frame))).toEqual(frames.map((f) => [...f]));
});

test('accepts an index that stores absolute offsets', () => {
  const { bytes } = buildAvi({ frames, audioAfterFirst: true, index: 'absolute' });
  const clip = parseAvi(bytes);
  if (clip.status !== 'ok') throw new Error(clip.status);
  expect(clip.frames.map((frame) => frameBytes(bytes, frame))).toEqual(frames.map((f) => [...f]));
});

test('keeps the complete frames of a truncated file', () => {
  const { bytes, frameStarts } = buildAvi({ frames, index: 'none' });
  const third = frameStarts[2] ?? 0;
  const cut = bytes.slice(0, third + 2);
  const clip = parseAvi(cut);
  if (clip.status !== 'ok') throw new Error(clip.status);
  expect(clip.truncated).toBe(true);
  expect(clip.frames.map((frame) => frameBytes(cut, frame))).toEqual([
    [...(frames[0] ?? [])],
    [...(frames[1] ?? [])],
  ]);
});

test('drops indexed frames that lie past the end of a truncated file', () => {
  const { bytes, frameStarts } = buildAvi({ frames });
  const cut = bytes.slice(0, (frameStarts[1] ?? 0) + 1);
  const clip = parseAvi(cut);
  // The index went with the cut, so frames come from the movi scan.
  if (clip.status !== 'ok') throw new Error(clip.status);
  expect(clip.truncated).toBe(true);
  expect(clip.frames).toHaveLength(1);
});

test('reports a handler other than MJPG by its FourCC', () => {
  expect(parseAvi(buildAvi({ handler: 'H264', frames }).bytes)).toEqual({
    status: 'unsupported_handler',
    fourcc: 'H264',
  });
});

test('rejects files that are not AVI or hold no frames', () => {
  expect(parseAvi(encoder.encode('RIFF....WAVEfmt ')).status).toBe('invalid');
  expect(parseAvi(new Uint8Array(4)).status).toBe('invalid');
  expect(parseAvi(buildAvi({ frames: [] }).bytes).status).toBe('invalid');
  const { bytes, frameStarts } = buildAvi({ frames, index: 'none' });
  expect(parseAvi(bytes.slice(0, (frameStarts[0] ?? 0) - 4)).status).toBe('invalid');
});

test('wraps a frame as a JPEG blob', async () => {
  const { bytes } = buildAvi({ frames });
  const clip = parseAvi(bytes);
  if (clip.status !== 'ok') throw new Error(clip.status);
  const blob = aviFrameBlob(bytes, clip.frames[1] ?? { offset: 0, length: 0 });
  expect(blob.type).toBe('image/jpeg');
  expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([...(frames[1] ?? [])]);
});

test('samples one frame per second up to the cap', () => {
  expect(VIDEO_MAX_FRAMES).toBe(10);
  expect(sampleSeconds(5)).toEqual([0, 1, 2, 3, 4]);
  expect(sampleSeconds(4.2)).toEqual([0, 1, 2, 3, 4]);
  expect(sampleSeconds(0.3)).toEqual([0]);
  expect(sampleSeconds(0)).toEqual([0]);
  expect(sampleSeconds(Number.NaN)).toEqual([0]);
  expect(sampleSeconds(Number.POSITIVE_INFINITY)).toEqual([0]);
  expect(sampleSeconds(95)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('recognizes HEVC sample entries in MP4 bytes', () => {
  expect(containsHevcMarker(encoder.encode('....stsd....hvc1....'))).toBe(true);
  expect(containsHevcMarker(encoder.encode('....hev1....'))).toBe(true);
  expect(containsHevcMarker(encoder.encode('....stsd....avc1....avcC'))).toBe(false);
});

test('times a clip from its file modification time', () => {
  const mtimeMs = Date.parse('2026-11-01T05:30:00Z');
  const file = new File([''], 'clip.avi', { lastModified: mtimeMs });
  const time = videoCameraTime(
    {
      path: 'clip.avi',
      name: 'clip.avi',
      kind: 'video',
      ext: 'avi',
      sizeBytes: 0,
      mtimeMs,
      source: file,
    },
    Date.UTC(2026, 10, 1, 12),
  );
  // TZ is America/New_York in tests; 05:30Z on 1 Nov 2026 is 01:30 EDT.
  expect(time.timeSource).toBe('file');
  expect(time.wallClockMs).toBe(Date.UTC(2026, 10, 1, 1, 30));
  expect(time.wallClockHour).toBe(1);
  expect(time.offsetTimeOriginal).toBeNull();
  expect(time.clockStatus).toBe(clockStatus(time.wallClockMs, Date.UTC(2026, 10, 1, 12)));
});
