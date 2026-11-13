// The decoder entry point keeps jpeg-js's encoder out of the worker bundle.
import decode from 'jpeg-js/lib/decoder.js';

type Orientation = { dimensionSwapped: boolean; scaleX: number; scaleY: number; rad: number };

// EXIF orientations 1 to 8, as the canvas transform that turns the stored pixels upright.
const ORIENTATIONS: readonly (Orientation | undefined)[] = [
  undefined,
  { dimensionSwapped: false, scaleX: 1, scaleY: 1, rad: 0 },
  { dimensionSwapped: false, scaleX: -1, scaleY: 1, rad: 0 },
  { dimensionSwapped: false, scaleX: 1, scaleY: 1, rad: Math.PI },
  { dimensionSwapped: false, scaleX: -1, scaleY: 1, rad: Math.PI },
  { dimensionSwapped: true, scaleX: 1, scaleY: -1, rad: Math.PI / 2 },
  { dimensionSwapped: true, scaleX: 1, scaleY: 1, rad: Math.PI / 2 },
  { dimensionSwapped: true, scaleX: 1, scaleY: -1, rad: (3 * Math.PI) / 2 },
  { dimensionSwapped: true, scaleX: 1, scaleY: 1, rad: (3 * Math.PI) / 2 },
];

/** Reads the orientation tag from a JPEG's EXIF segment; absent or damaged EXIF gives undefined. */
export function jpegOrientation(bytes: Uint8Array): Orientation | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) return undefined;
    const end = offset + 2 + view.getUint16(offset + 2);
    const tiff = offset + 10;
    // "Exif" opens the segment, then the TIFF header gives the byte order and the first directory.
    if (
      marker === 0xe1 &&
      tiff + 8 <= end &&
      end <= bytes.length &&
      view.getUint32(offset + 4) === 0x45786966
    ) {
      const little = view.getUint16(tiff) === 0x4949;
      const directory = tiff + view.getUint32(tiff + 4, little);
      if (directory + 2 > end) return undefined;
      const last = Math.min(end, directory + 2 + view.getUint16(directory, little) * 12);
      for (let entry = directory + 2; entry + 12 <= last; entry += 12)
        if (view.getUint16(entry, little) === 0x0112)
          return ORIENTATIONS[view.getUint16(entry + 8, little)];
      return undefined;
    }
    offset = end;
  }
  return undefined;
}

export function isCmykJpeg(bytes: Uint8Array): boolean {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) return false;
    const length = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
    if (length < 2 || offset + length > bytes.length) return false;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2)
      return length >= 8 && bytes[offset + 7] === 4;
    offset += length;
  }
  return false;
}

export async function decodePhoto(file: Blob): Promise<ImageBitmap> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isCmykJpeg(bytes))
    return createImageBitmap(file, {
      imageOrientation: 'from-image',
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });

  // WebKit's native CMYK conversion differs from PIL even with colour conversion disabled.
  const image = decode(bytes, { useTArray: true });
  const bitmap = await createImageBitmap(
    new ImageData(new Uint8ClampedArray(image.data), image.width, image.height),
  );
  try {
    const transform = jpegOrientation(bytes);
    const width = transform?.dimensionSwapped ? image.height : image.width;
    const height = transform?.dimensionSwapped ? image.width : image.height;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { colorSpace: 'srgb' });
    if (!context) throw new Error('Could not create a CMYK photo canvas');
    // Exact right angles avoid Firefox interpolating pixels at fractional rotation boundaries.
    const cos = Math.round(Math.cos(transform?.rad ?? 0));
    const sin = Math.round(Math.sin(transform?.rad ?? 0));
    const scaleX = transform?.scaleX ?? 1;
    const scaleY = transform?.scaleY ?? 1;
    context.setTransform(
      cos * scaleX,
      sin * scaleX,
      -sin * scaleY,
      cos * scaleY,
      width / 2,
      height / 2,
    );
    context.drawImage(bitmap, -image.width / 2, -image.height / 2);
    return canvas.transferToImageBitmap();
  } finally {
    bitmap.close();
  }
}
