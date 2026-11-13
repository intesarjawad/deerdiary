import { MAXN_MIN_CONF } from '../core/events';
import { extractVideoFrames } from '../files/video';
import type { StoredResult } from '../storage/schema';
import type { Backend, ClassifiedDetection, PhotoResult, StageTimes } from '../workers/photo';

export type ClipFrames =
  | { status: 'ok'; frames: File[] }
  | { status: 'unsupported_codec'; codec: string }
  | { status: 'decode_failed' };

type FrameResult = Extract<PhotoResult, { status: 'ok' }>;

const CODEC_NAMES: Readonly<Record<string, string>> = { hevc: 'HEVC' };
const UNRECOGNISED_CODEC = 'unrecognised';

/**
 * Samples a clip at one frame per second and encodes each frame as PNG, so the photo worker
 * decodes exactly the pixels the video element drew, with no second lossy step.
 */
export async function clipFrameFiles(file: File): Promise<ClipFrames> {
  const sampled = await extractVideoFrames(file);
  if (sampled.status !== 'ok') return sampled;
  try {
    const frames: File[] = [];
    for (const [index, bitmap] of sampled.frames.entries()) {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      if (!context) return { status: 'decode_failed' };
      context.drawImage(bitmap, 0, 0);
      const png = await canvas.convertToBlob({ type: 'image/png' });
      frames.push(new File([png], `${file.name}.${index}.png`, { type: 'image/png' }));
    }
    return { status: 'ok', frames };
  } finally {
    for (const bitmap of sampled.frames) bitmap.close();
  }
}

function countedLabel(detection: ClassifiedDetection): string {
  return detection.processed_classification?.class ?? detection.label;
}

function totalTimes(outputs: readonly PhotoResult[]): StageTimes {
  const sum = (stage: keyof StageTimes) => outputs.reduce((total, { ms }) => total + ms[stage], 0);
  return {
    decode: sum('decode'),
    preprocess: sum('preprocess'),
    detect: sum('detect'),
    classify: sum('classify'),
    ensemble: sum('ensemble'),
    thumbnail: sum('thumbnail'),
    total: sum('total'),
  };
}

/** The stored result of a clip whose frames could not be read. */
export function skippedClip(
  path: string,
  backend: Backend,
  failure: Exclude<ClipFrames, { status: 'ok' }>,
): PhotoResult {
  return { path, backend, ms: totalTimes([]), ...failure };
}

/**
 * A clip is one result. For each label it keeps the boxes of the frame where the most of them
 * pass the MaxN confidence, so MaxN over the clip equals the largest count in any one frame.
 */
export function mergeClipFrames(path: string, outputs: readonly PhotoResult[]): PhotoResult {
  const ms = totalTimes(outputs);
  const backend = outputs.at(-1)?.backend ?? 'wasm';
  const frames = outputs.filter((output): output is FrameResult => output.status === 'ok');
  const [first] = frames;
  if (first === undefined) return { path, backend, ms, status: 'decode_failed' };
  const best = new Map<string, { qualifying: number; detections: ClassifiedDetection[] }>();
  for (const frame of frames) {
    const byLabel = new Map<string, ClassifiedDetection[]>();
    for (const detection of frame.detections) {
      const label = countedLabel(detection);
      byLabel.set(label, [...(byLabel.get(label) ?? []), detection]);
    }
    for (const [label, detections] of byLabel) {
      const qualifying = detections.filter(({ conf }) => conf >= MAXN_MIN_CONF).length;
      if (qualifying > (best.get(label)?.qualifying ?? -1))
        best.set(label, { qualifying, detections });
    }
  }
  const confidence = (frame: FrameResult) => frame.detections[0]?.conf ?? -1;
  // The worker crops each frame's preview to that frame's most confident box.
  const preview = frames.reduce((kept, frame) =>
    confidence(frame) > confidence(kept) ? frame : kept,
  );
  return {
    path,
    backend,
    ms,
    status: 'ok',
    width: first.width,
    height: first.height,
    detections: [...best.values()]
      .flatMap(({ detections }) => detections)
      .toSorted((a, b) => b.conf - a.conf),
    thumbnail: preview.thumbnail,
  };
}

/** Says which clips were skipped for their codec and how to make them readable. */
export function unsupportedClipsNote(results: readonly StoredResult[]): string | null {
  const codecs = new Set<string>();
  let count = 0;
  for (const { output } of results) {
    if (output.status !== 'unsupported_codec') continue;
    count++;
    // An AVI handler is a space-padded FourCC; the video element path reports 'unknown'.
    const fourcc = output.codec === 'unknown' ? '' : output.codec.replace(/[\0\s]+/g, '');
    codecs.add(CODEC_NAMES[output.codec] ?? (fourcc || UNRECOGNISED_CODEC));
  }
  if (count === 0) return null;
  const one = count === 1;
  return `${count} video${one ? '' : 's'} could not be decoded in this browser (codec: ${[...codecs].sort().join(', ')}) and ${one ? 'was' : 'were'} skipped. Convert ${one ? 'it' : 'them'} to H.264 MP4, for example with "ffmpeg -i input.avi -c:v libx264 output.mp4", then drop the folder again.`;
}
