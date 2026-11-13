import { resizeBilinear, toUint8LikeTorchvision, validatePixels } from './resize';
import type { Detection } from './types';

/** Full-resolution tensor crop with truncation toward zero and zero padding outside the image. */
export function cropBox(pixels: Uint8Array, srcW: number, srcH: number, bbox: Detection['bbox']) {
  const channels = validatePixels(pixels, srcW, srcH);
  if (!bbox.every(Number.isFinite)) throw new Error('Crop coordinates must be finite');
  const [x, y, w, h] = bbox;
  const left = Math.trunc(x * srcW);
  const top = Math.trunc(y * srcH);
  const width = Math.trunc(w * srcW);
  const height = Math.trunc(h * srcH);
  if (width <= 0 || height <= 0) throw new Error('Crop must contain at least one pixel');
  const data = new Uint8Array(width * height * 3);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      if (row + top < 0 || row + top >= srcH || col + left < 0 || col + left >= srcW) continue;
      for (let c = 0; c < 3; c++)
        data[(row * width + col) * 3 + c] =
          pixels[((row + top) * srcW + col + left) * channels + c] ?? 0;
    }
  }
  return { data, width, height };
}

/**
 * Preview size: the whole frame scaled to fit `longEdge`, never enlarged. Normalized detection
 * boxes only land on a preview that keeps the frame's full extent and aspect ratio.
 */
export function thumbnailSize(srcW: number, srcH: number, longEdge: number) {
  const scale = Math.min(1, longEdge / Math.max(srcW, srcH));
  return {
    width: Math.max(1, Math.round(srcW * scale)),
    height: Math.max(1, Math.round(srcH * scale)),
  };
}

/** SpeciesNet always_crop input, HWC uint8 at 480 pixels. */
export function classifierCrop(
  pixels: Uint8Array,
  srcW: number,
  srcH: number,
  bbox: Detection['bbox'],
): Uint8Array {
  const crop = cropBox(pixels, srcW, srcH, bbox);
  return Uint8Array.from(
    resizeBilinear(crop.data, crop.width, crop.height, 480, 480),
    toUint8LikeTorchvision,
  );
}
