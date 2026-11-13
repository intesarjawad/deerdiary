import { resizeBilinear } from './resize';

export const LETTERBOX_PAD = 114;

function dimension(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error('Image dimensions must be positive integers');
}

/** YOLO fixed-square or minimum-stride padding, using Python's ties-to-even rounding. */
export function letterboxGeometry(
  srcW: number,
  srcH: number,
  size: number,
  stride: number,
  auto: boolean,
) {
  for (const value of [srcW, srcH, size, stride]) dimension(value);
  const scale = Math.min(size / srcW, size / srcH);
  const roundEven = (x: number) => (x % 1 === 0.5 ? 2 * Math.round(x / 2) : Math.round(x));
  const resizedWidth = roundEven(srcW * scale);
  const resizedHeight = roundEven(srcH * scale);
  const padW = auto ? (size - resizedWidth) % stride : size - resizedWidth;
  const padH = auto ? (size - resizedHeight) % stride : size - resizedHeight;
  return {
    srcW,
    srcH,
    scale,
    resizedWidth,
    resizedHeight,
    width: resizedWidth + padW,
    height: resizedHeight + padH,
    left: Math.floor(padW / 2),
    top: Math.floor(padH / 2),
    right: Math.ceil(padW / 2),
    bottom: Math.ceil(padH / 2),
  };
}

/** RT-DETR stretches the whole image; it has no padding. */
export function stretchGeometry(srcW: number, srcH: number, size = 640) {
  for (const value of [srcW, srcH, size]) dimension(value);
  return { srcW, srcH, width: size, height: size, scaleX: size / srcW, scaleY: size / srcH };
}

/** RGB NCHW float32 in 0..1: bilinear resize rounded to uint8 as OpenCV does, then constant padding. */
export function letterboxInput(
  pixels: Uint8Array,
  geometry: ReturnType<typeof letterboxGeometry>,
): Float32Array {
  const { srcW, srcH, resizedWidth, resizedHeight, width, height, left, top } = geometry;
  const plane = width * height;
  const input = new Float32Array(3 * plane).fill(LETTERBOX_PAD / 255);
  const resized = resizeBilinear(pixels, srcW, srcH, resizedWidth, resizedHeight);
  for (let y = 0; y < resizedHeight; y++) {
    for (let x = 0; x < resizedWidth; x++) {
      for (let c = 0; c < 3; c++)
        input[c * plane + (y + top) * width + x + left] =
          Math.round((resized[(y * resizedWidth + x) * 3 + c] ?? 0) * 255) / 255;
    }
  }
  return input;
}
