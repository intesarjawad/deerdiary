import { describe, expect, it } from 'vitest';
import { isCmykJpeg, jpegOrientation } from '../../src/workers/jpeg';

function frame(marker: number, components: number) {
  const length = 8 + components * 3;
  return [
    0xff,
    marker,
    0,
    length,
    8,
    0,
    16,
    0,
    24,
    components,
    ...new Array(components * 3).fill(1),
  ];
}

describe('CMYK JPEG recognition', () => {
  it.each([0xc0, 0xc1, 0xc2])('recognizes four components in frame %i', (marker) => {
    expect(isCmykJpeg(new Uint8Array([0xff, 0xd8, ...frame(marker, 4)]))).toBe(true);
  });

  it.each([1, 3])('keeps native decoding for %i components', (components) => {
    expect(isCmykJpeg(new Uint8Array([0xff, 0xd8, ...frame(0xc0, components)]))).toBe(false);
  });

  it('skips metadata by its length, including embedded markers and marker padding', () => {
    const metadata = [0xff, 0xe1, 0, 6, 0xff, 0xc0, 0xff, 0xda];
    expect(isCmykJpeg(new Uint8Array([0xff, 0xd8, ...metadata, 0xff, ...frame(0xc2, 4)]))).toBe(
      true,
    );
  });

  it.each(
    [
      [],
      [0xff],
      [0xff, 0xd8],
      [0xff, 0xd8, 0xff, 0xff, 0xff, 0xff],
      [0xff, 0xd8, 0xff, 0xe1, 0, 0],
      [0xff, 0xd8, 0xff, 0xe1, 0, 1],
      [0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff],
      [0xff, 0xd8, 0xff, 0xc0, 0, 2],
      [0xff, 0xd8, 0, 0, 0, 0],
      [0xff, 0xd8, 0xff, 0xda, 0, 2, ...frame(0xc0, 4)],
      [0xff, 0xd8, 0xff, 0xd9, 0, 2, ...frame(0xc0, 4)],
      [0x89, 0x50, 0x4e, 0x47, ...frame(0xc0, 4)],
    ].map((bytes) => ({ bytes })),
  )(
    'leaves incomplete, malformed and non-JPEG headers to the native decoder: $bytes',
    ({ bytes }) => {
      expect(isCmykJpeg(new Uint8Array(bytes))).toBe(false);
    },
  );
});

function exifSegment(orientation: number, little: boolean): number[] {
  const u16 = (value: number) => (little ? [value & 0xff, value >> 8] : [value >> 8, value & 0xff]);
  const u32 = (value: number) => (little ? [...u16(value), 0, 0] : [0, 0, ...u16(value)]);
  const tiff = [
    ...(little ? [0x49, 0x49] : [0x4d, 0x4d]),
    ...u16(42),
    ...u32(8),
    ...u16(1),
    ...u16(0x0112),
    ...u16(3),
    ...u32(1),
    ...u16(orientation),
    0,
    0,
    ...u32(0),
  ];
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  return [0xff, 0xe1, 0, payload.length + 2, ...payload];
}

describe('JPEG orientation', () => {
  it.each([true, false])('reads the tag in either byte order (little endian: %s)', (little) => {
    const bytes = new Uint8Array([0xff, 0xd8, ...exifSegment(6, little), ...frame(0xc0, 4)]);
    expect(jpegOrientation(bytes)).toEqual({
      dimensionSwapped: true,
      scaleX: 1,
      scaleY: 1,
      rad: Math.PI / 2,
    });
  });

  it('mirrors orientation 2 without rotating', () => {
    const bytes = new Uint8Array([0xff, 0xd8, ...exifSegment(2, true)]);
    expect(jpegOrientation(bytes)).toMatchObject({ scaleX: -1, rad: 0, dimensionSwapped: false });
  });

  it.each([
    ['no EXIF segment', [0xff, 0xd8, ...frame(0xc0, 4)]],
    ['a truncated EXIF segment', [0xff, 0xd8, ...exifSegment(6, true).slice(0, 14)]],
    ['an orientation outside 1 to 8', [0xff, 0xd8, ...exifSegment(9, true)]],
  ])('gives undefined for %s', (_name, bytes) => {
    expect(jpegOrientation(new Uint8Array(bytes))).toBeUndefined();
  });
});
