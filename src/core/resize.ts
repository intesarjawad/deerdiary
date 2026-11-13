function validateDimensions(width: number, height: number) {
  if (![width, height].every((v) => Number.isSafeInteger(v) && v > 0))
    throw new Error('Image dimensions must be positive integers');
}

/** Model pixels are interleaved RGB or RGBA; alpha is ignored. */
export function validatePixels(pixels: Uint8Array, width: number, height: number): number {
  validateDimensions(width, height);
  const channels = pixels.length / (width * height);
  if (channels !== 3 && channels !== 4) throw new Error('Expected RGB or RGBA pixels');
  return channels;
}

export function toUint8LikeTorchvision(x: number): number {
  return Math.trunc(x * 255.999);
}

/** Float32 RGB in 0..1, matching tensor bilinear resize without antialiasing. */
export function resizeBilinear(
  pixels: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Float32Array {
  const channels = validatePixels(pixels, srcW, srcH);
  validateDimensions(dstW, dstH);
  const output = new Float32Array(dstW * dstH * 3);
  for (let y = 0; y < dstH; y++) {
    const sy = Math.max(0, Math.fround(Math.fround(srcH / dstH) * Math.fround(y + 0.5) - 0.5));
    const y0 = Math.min(Math.floor(sy), srcH - 1);
    const y1 = Math.min(y0 + 1, srcH - 1);
    const fy = Math.fround(sy - y0);
    for (let x = 0; x < dstW; x++) {
      const sx = Math.max(0, Math.fround(Math.fround(srcW / dstW) * Math.fround(x + 0.5) - 0.5));
      const x0 = Math.min(Math.floor(sx), srcW - 1);
      const x1 = Math.min(x0 + 1, srcW - 1);
      const fx = Math.fround(sx - x0);
      for (let c = 0; c < 3; c++) {
        const a = Math.fround((pixels[(y0 * srcW + x0) * channels + c] ?? 0) / 255);
        const b = Math.fround((pixels[(y0 * srcW + x1) * channels + c] ?? 0) / 255);
        const d = Math.fround((pixels[(y1 * srcW + x0) * channels + c] ?? 0) / 255);
        const e = Math.fround((pixels[(y1 * srcW + x1) * channels + c] ?? 0) / 255);
        const upper = Math.fround(Math.fround((1 - fx) * a) + Math.fround(fx * b));
        const lower = Math.fround(Math.fround((1 - fx) * d) + Math.fround(fx * e));
        output[(y * dstW + x) * 3 + c] = Math.fround(
          Math.fround((1 - fy) * upper) + Math.fround(fy * lower),
        );
      }
    }
  }
  return output;
}

type Filter = { start: number; weights: number[] };

function pilFilters(source: number, target: number): Filter[] {
  const scale = source / target;
  const support = Math.max(1, scale);
  return Array.from({ length: target }, (_, i) => {
    const center = (i + 0.5) * scale;
    const start = Math.max(0, Math.trunc(center - support + 0.5));
    const end = Math.min(source, Math.trunc(center + support + 0.5));
    const weights = Array.from({ length: end - start }, (_, j) =>
      Math.max(0, 1 - Math.abs((start + j - center + 0.5) / support)),
    );
    const sum = weights.reduce((a, b) => a + b, 0);
    // PIL's uint8 resampler uses 22-bit fixed-point coefficients and rounds each pass.
    return { start, weights: weights.map((w) => Math.trunc((w / sum) * 2 ** 22 + 0.5)) };
  });
}

/** PIL BILINEAR: widened downsampling support and uint8 rounding between passes. */
export function resizeBilinearPil(
  pixels: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Uint8Array {
  const channels = validatePixels(pixels, srcW, srcH);
  validateDimensions(dstW, dstH);
  const output = new Uint8Array(dstW * dstH * 3);
  const horizontal = new Uint8Array(dstW * srcH * 3);
  const filtersX = pilFilters(srcW, dstW);
  const filtersY = pilFilters(srcH, dstH);
  for (let y = 0; y < srcH; y++) {
    for (const [x, filter] of filtersX.entries()) {
      for (let c = 0; c < 3; c++) {
        let sum = 2 ** 21;
        for (const [j, w] of filter.weights.entries())
          sum += (pixels[(y * srcW + filter.start + j) * channels + c] ?? 0) * w;
        horizontal[(y * dstW + x) * 3 + c] = Math.floor(sum / 2 ** 22);
      }
    }
  }
  for (const [y, filter] of filtersY.entries()) {
    for (let x = 0; x < dstW; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 2 ** 21;
        for (const [j, w] of filter.weights.entries())
          sum += (horizontal[((filter.start + j) * dstW + x) * 3 + c] ?? 0) * w;
        output[(y * dstW + x) * 3 + c] = Math.floor(sum / 2 ** 22);
      }
    }
  }
  return output;
}
