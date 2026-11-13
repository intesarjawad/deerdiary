import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Classification } from '../../src/core/labels';
import { loadTaxonomy } from '../../src/core/taxonomy';
import type { Detection } from '../../src/core/types';
import { appendMissingJpegEndMarker, PhotoProcessor, topFive } from '../../src/workers/photo';
import assets from '../golden/ensemble_assets.json';
import gbr from '../golden/speciesnet_cli.gbr.json';
import raw from '../golden/speciesnet_cli.raw.json';

const labels = [
  Classification.HUMAN,
  Classification.BLANK,
  Classification.VEHICLE,
  Classification.ANIMAL,
  Classification.UNKNOWN,
];
const pixels = new Uint8ClampedArray([
  255, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 0,
  255, 0, 255, 0, 255, 0, 255,
]);
const close = vi.fn();
const decode = vi.fn(async () => ({ width: 4, height: 2, close }));
const drawImage = vi.fn();
const getImageData = vi.fn(() => ({ data: pixels }));
const convertToBlob = vi.fn(async () => new Blob(['jpeg'], { type: 'image/jpeg' }));
const file = new File(['jpeg'], 'card.jpg');
const detection = (conf: number, bbox: Detection['bbox'] = [0, 0, 1, 1]): Detection => ({
  category: '2',
  conf,
  bbox,
});

beforeEach(() => {
  vi.stubGlobal('createImageBitmap', decode);
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      getContext() {
        return {
          drawImage,
          getImageData,
          createImageData: (width: number, height: number) => ({
            data: new Uint8ClampedArray(width * height * 4),
          }),
          putImageData: vi.fn(),
        };
      }
      convertToBlob = convertToBlob;
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function setup(detections: Detection[] = [detection(0.9)]) {
  const detect = vi.fn(async (_input: Float32Array, _width: number, _height: number) => detections);
  const classify = vi.fn(async (_input: Uint8Array) => new Float32Array([1000, 0, 0, 0, 0]));
  const processor = new PhotoProcessor({ backend: 'wasm', detect, classify }, labels, {
    taxonomyMap: {},
    geofenceMap: {},
  });
  return { processor, detect, classify };
}

describe('detector with its own preprocessing', () => {
  it('receives the decoded RGBA pixels and skips the shared 640 input', async () => {
    const detect = vi.fn(async (_input: Float32Array, _width: number, _height: number) => []);
    const detectPixels = vi.fn(async (_pixels: Uint8Array, _width: number, _height: number) => [
      detection(0.9),
    ]);
    const classify = vi.fn(async (_input: Uint8Array) => new Float32Array([1000, 0, 0, 0, 0]));
    const processor = new PhotoProcessor(
      { backend: 'wasm', detect, detectPixels, classify },
      labels,
      {
        taxonomyMap: {},
        geofenceMap: {},
      },
    );
    const result = await processor.process({ file, settings: {} });
    expect(detect).not.toHaveBeenCalled();
    expect(detectPixels).toHaveBeenCalledOnce();
    expect(Array.from(detectPixels.mock.calls[0]?.[0] ?? [])).toEqual(Array.from(pixels));
    expect(detectPixels.mock.calls[0]?.slice(1)).toEqual([4, 2]);
    if (result.status !== 'ok') throw new Error('Expected an ok result');
    expect(result.detections).toHaveLength(1);
    expect(result.ms.detect).toBeGreaterThanOrEqual(0);
  });
});

describe('full-resolution photo inference', () => {
  it('decodes with EXIF and no colour conversion, stretches RGB NCHW and ensembles every crop', async () => {
    const { processor, detect, classify } = setup([detection(0.9, [0.5, 0, 0.5, 1])]);
    const result = await processor.process({ file, settings: { path: 'DCIM/card.jpg' } });
    expect(decode).toHaveBeenCalledWith(file, {
      imageOrientation: 'from-image',
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
    expect(drawImage).toHaveBeenCalledWith(expect.objectContaining({ width: 4, height: 2 }), 0, 0);
    expect(getImageData).toHaveBeenCalledWith(0, 0, 4, 2);
    const input = detect.mock.calls[0]?.[0];
    expect(input).toHaveLength(3 * 640 * 640);
    expect(input?.[0]).toBe(1);
    expect(input?.[640 * 640]).toBe(0);
    expect(input?.[640 * 640 - 1]).toBe(0);
    expect(input?.[2 * 640 * 640 - 1]).toBe(1);
    expect(detect).toHaveBeenCalledWith(expect.any(Float32Array), 4, 2);
    expect(classify.mock.calls[0]?.[0].slice(0, 3)).toEqual(new Uint8Array([0, 255, 0]));
    expect(result).toMatchObject({
      status: 'ok',
      path: 'DCIM/card.jpg',
      width: 4,
      height: 2,
      backend: 'wasm',
      detections: [
        {
          label: 'human',
          raw_classifications: { classes: labels },
          processed_classification: { class: Classification.HUMAN, source: 'detector', score: 0.9 },
        },
      ],
    });
    expect(Object.values(result.ms).every((value) => Number.isFinite(value) && value >= 0)).toBe(
      true,
    );
    expect(convertToBlob).toHaveBeenCalledWith({ type: 'image/jpeg', quality: 0.8 });
    expect(close).toHaveBeenCalledOnce();
    expect(result).not.toHaveProperty('jpegRepaired');
  });

  it('classifies the highest five at 0.1 inclusive and retains other raw detections', async () => {
    const { processor, classify } = setup(
      [0.01, 0.09, 0.1, 0.3, 0.7, 0.2, 0.4, 0.02].map((conf) => detection(conf)),
    );
    const result = await processor.process({ file, settings: {} });
    expect(classify).toHaveBeenCalledTimes(5);
    if (result.status !== 'ok') throw new Error('Photo did not decode');
    expect(result.detections.map((value) => value.conf)).toEqual([
      0.7, 0.4, 0.3, 0.2, 0.1, 0.09, 0.02, 0.01,
    ]);
    expect(result.detections.filter((value) => value.raw_classifications)).toHaveLength(5);
    expect(result.detections[5]?.processed_classification).toBeUndefined();
    const limited = setup([0.99, 0.98, 0.97, 0.96, 0.95, 0.94].map((conf) => detection(conf)));
    const capped = await limited.processor.process({ file, settings: {} });
    expect(limited.classify).toHaveBeenCalledTimes(5);
    if (capped.status !== 'ok') throw new Error('Photo did not decode');
    expect(capped.detections[5]?.raw_classifications).toBeUndefined();
    // It decodes a full-resolution photo twice, about 9 s when the machine is busy, not 5.
  }, 20_000);

  it('reuses detector and classifier inputs between photos and crops', async () => {
    const { processor, detect, classify } = setup([detection(0.8), detection(0.9)]);
    await processor.process({ file, settings: {} });
    await processor.process({ file, settings: {} });
    expect(detect.mock.calls[0]?.[0]).toBe(detect.mock.calls[1]?.[0]);
    expect(classify.mock.calls[0]?.[0]).toBe(classify.mock.calls[3]?.[0]);
  });

  it('injects saved boxes without running the detector and applies country to the real ensemble', async () => {
    const bear = raw.predictions.find((photo) =>
      photo.filepath.endsWith('/american_black_bear.jpg'),
    );
    const original = bear?.detections.find((value) => value.raw_classifications);
    if (!original?.raw_classifications) throw new Error('Missing bear reference');
    const classes = original.raw_classifications.classes;
    const processor = new PhotoProcessor(
      {
        backend: 'wasm',
        detect: vi.fn(async () => {
          throw new Error('Detector must be bypassed');
        }),
        classify: async () => Float32Array.from(original.raw_classifications.scores, Math.log),
      },
      classes,
      {
        taxonomyMap: loadTaxonomy(
          gunzipSync(Buffer.from(assets.taxonomyGzip, 'base64')).toString('utf8'),
        ),
        geofenceMap: assets.geofence,
      },
    );
    const result = await processor.process({
      file,
      settings: { country: 'GBR' },
      detections: [{ category: '1', conf: original.conf, bbox: [0, 0, 1, 1] }],
    });
    const expected = gbr.predictions.find((photo) => photo.filepath === bear?.filepath)
      ?.detections[0]?.processed_classification;
    if (result.status !== 'ok' || !expected) throw new Error('Missing bear result');
    expect(result.detections[0]?.processed_classification?.class).toBe(expected.class);
    expect(result.detections[0]?.processed_classification?.source).toBe(
      'classifier+geofence+rollup_to_order',
    );
    expect(result.ms.detect).toBe(0);
  });

  it('returns an empty successful photo with a whole-image thumbnail when no animals are found', async () => {
    const { processor, classify } = setup([]);
    const result = await processor.process({ file, settings: {} });
    expect(result).toMatchObject({ status: 'ok', detections: [], thumbnail: expect.any(Blob) });
    expect(classify).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('reports decode failures and processes the next photo', async () => {
    decode.mockRejectedValueOnce(new Error('Invalid JPEG'));
    const { processor, detect } = setup();
    expect(await processor.process({ file, settings: {} })).toMatchObject({
      status: 'decode_failed',
      path: 'card.jpg',
    });
    expect(detect).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(decode).toHaveBeenCalledOnce();
    expect(await processor.process({ file, settings: {} })).toMatchObject({ status: 'ok' });
  });

  it('keeps a successfully decoded JPEG unchanged even without an end marker', async () => {
    const truncated = new File([new Uint8Array([0xff, 0xd8, 0x12])], 'card.jpg');
    const { processor } = setup([]);
    const result = await processor.process({ file: truncated, settings: {} });
    expect(result.status).toBe('ok');
    expect(result).not.toHaveProperty('jpegRepaired');
    expect(decode).toHaveBeenCalledOnce();
    expect(vi.mocked(createImageBitmap).mock.calls[0]?.[0]).toBe(truncated);
  });

  it('retries a truncated JPEG once and marks successful recovery', async () => {
    const truncated = new File([new Uint8Array([0xff, 0xd8, 0x12])], 'card.bin');
    decode.mockRejectedValueOnce(new Error('Incomplete JPEG'));
    const { processor } = setup([]);
    const result = await processor.process({ file: truncated, settings: {} });
    expect(result).toMatchObject({ status: 'ok', jpegRepaired: true, width: 4, height: 2 });
    expect(decode).toHaveBeenCalledTimes(2);
    const [repaired, options] = vi.mocked(createImageBitmap).mock.calls[1] ?? [];
    expect(repaired).toBeInstanceOf(Blob);
    if (!(repaired instanceof Blob)) throw new Error('Missing repaired JPEG');
    expect(new Uint8Array(await repaired.arrayBuffer())).toEqual(
      new Uint8Array([0xff, 0xd8, 0x12, 0xff, 0xd9]),
    );
    expect(options).toEqual(vi.mocked(createImageBitmap).mock.calls[0]?.[1]);
    expect(new Uint8Array(await truncated.arrayBuffer())).toEqual(
      new Uint8Array([0xff, 0xd8, 0x12]),
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it('reports failure when the repaired JPEG still cannot decode', async () => {
    const truncated = new File([new Uint8Array([0xff, 0xd8, 0x12])], 'card.jpg');
    decode.mockRejectedValueOnce(new Error('Incomplete JPEG'));
    decode.mockRejectedValueOnce(new Error('Invalid JPEG'));
    const { processor, detect } = setup();
    expect(await processor.process({ file: truncated, settings: {} })).toMatchObject({
      status: 'decode_failed',
    });
    expect(decode).toHaveBeenCalledTimes(2);
    expect(detect).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('does not retry a failed JPEG that already has its end marker', async () => {
    const complete = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'card.jpg');
    decode.mockRejectedValueOnce(new Error('Invalid JPEG'));
    const { processor } = setup();
    expect(await processor.process({ file: complete, settings: {} })).toMatchObject({
      status: 'decode_failed',
    });
    expect(decode).toHaveBeenCalledOnce();
  });

  it('closes the bitmap after canvas, detector, classifier and thumbnail failures', async () => {
    const { processor, detect, classify } = setup();
    getImageData.mockImplementationOnce(() => {
      throw new Error('Canvas read failed');
    });
    await expect(processor.process({ file, settings: {} })).rejects.toThrow('Canvas read failed');
    detect.mockRejectedValueOnce(new Error('Detector failed'));
    await expect(processor.process({ file, settings: {} })).rejects.toThrow('Detector failed');
    classify.mockRejectedValueOnce(new Error('Classifier failed'));
    await expect(processor.process({ file, settings: {} })).rejects.toThrow('Classifier failed');
    convertToBlob.mockRejectedValueOnce(new Error('JPEG failed'));
    await expect(processor.process({ file, settings: {} })).rejects.toThrow('JPEG failed');
    expect(close).toHaveBeenCalledTimes(4);
  });
});

describe('JPEG end marker repair', () => {
  it.each([[], [0xff], [0xff, 0xd9], [0x89, 0x50, 0x4e, 0x47], [0xff, 0xd8, 0xff, 0xd9]])(
    'leaves non-JPEG or terminated bytes unchanged: %j',
    (...values) => {
      const bytes = new Uint8Array(values);
      expect(appendMissingJpegEndMarker(bytes)).toBeUndefined();
      expect([...bytes]).toEqual(values);
    },
  );

  it.each([
    [0xff, 0xd8],
    [0xff, 0xd8, 0x12],
    [0xff, 0xd8, 0xff],
    [0xff, 0xd8, 0xd9],
  ])('appends a complete marker without changing the original bytes: %j', (...values) => {
    const bytes = new Uint8Array(values);
    expect(appendMissingJpegEndMarker(bytes)).toEqual(new Uint8Array([...values, 0xff, 0xd9]));
    expect([...bytes]).toEqual(values);
  });
});

it('uses stable softmax and keeps the original order for ties', () => {
  expect(topFive(new Float32Array([1000, 1000, -1000, 0, 0]), labels)).toEqual({
    classes: labels,
    scores: [0.5, 0.5, 0, 0, 0],
  });
  expect(() => topFive(new Float32Array([NaN, 1, 2, 3, 4]), labels)).toThrow('finite');
  expect(() => topFive(new Float32Array(4), labels)).toThrow('matching');
});
