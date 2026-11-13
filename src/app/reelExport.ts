import { signal } from '@preact/signals';
import {
  REEL_FRAME_RATE,
  REEL_HEIGHT,
  REEL_SCALE_DRIFT,
  REEL_WIDTH,
  type ReelLayer,
  reelDurationMs,
  reelFrameCount,
  reelLayers,
} from '../core/reel';

/** H.264 High profile, level 4.0: the lowest level that holds 1280 by 720 at 30 frames a second. */
export const REEL_H264_CODEC = 'avc1.640028';
// In order of preference; WebKit's MediaRecorder may write only MP4.
const RECORDER_TYPES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4',
] as const;
export const REEL_UNSUPPORTED_MESSAGE = 'Reel export is not supported in this browser.';

const BACKGROUND = '#111';
const FOREGROUND = '#fff';
const CARD_MARGIN_PX = 96;
const TITLE_FONT = '600 64px system-ui, sans-serif';
const LINE_FONT = '36px system-ui, sans-serif';
const TITLE_GAP_PX = 88;
const LINE_GAP_PX = 56;

export type ReelEncoding =
  | { kind: 'webcodecs' }
  | { kind: 'recorder'; mimeType: string }
  | { kind: 'unsupported' };

type SupportedEncoding = Exclude<ReelEncoding, { kind: 'unsupported' }>;

type ReelEncoders = {
  VideoEncoder?: Pick<typeof VideoEncoder, 'isConfigSupported'> | undefined;
  MediaRecorder?: Pick<typeof MediaRecorder, 'isTypeSupported'> | undefined;
};

type ReelEndCardText = { title: string; lines: readonly string[] };

export type ReelExportRequest = { paths: readonly string[]; endCard: ReelEndCardText | null };

type ReelVideo = { photos: readonly Blob[]; endCard: ReelEndCardText | null };

type ReelExportState =
  | { status: 'checking' }
  | { status: 'unsupported' }
  | { status: 'ready' }
  | { status: 'exporting'; percent: number }
  | { status: 'failed'; message: string };

export type ReelExporterOptions = {
  /** Resolves the original photo for a chosen shot. */
  loadPhoto: (path: string) => Promise<Blob>;
  save: (file: { name: string; blob: Blob }) => void;
  detect?: () => Promise<ReelEncoding>;
  encode?: (
    encoding: SupportedEncoding,
    video: ReelVideo,
    onProgress: (fraction: number) => void,
  ) => Promise<Blob>;
};

async function supportsH264(encoder: ReelEncoders['VideoEncoder']): Promise<boolean> {
  if (!encoder) return false;
  try {
    const support = await encoder.isConfigSupported({
      codec: REEL_H264_CODEC,
      width: REEL_WIDTH,
      height: REEL_HEIGHT,
    });
    return support.supported === true;
  } catch {
    // Some engines reject a codec they lack instead of reporting it unsupported.
    return false;
  }
}

/** MP4 through WebCodecs when the browser encodes H.264, otherwise whatever MediaRecorder writes. */
export async function detectReelEncoding(
  encoders: ReelEncoders = globalThis,
): Promise<ReelEncoding> {
  if (await supportsH264(encoders.VideoEncoder)) return { kind: 'webcodecs' };
  const mimeType = RECORDER_TYPES.find((type) => encoders.MediaRecorder?.isTypeSupported(type));
  return mimeType === undefined ? { kind: 'unsupported' } : { kind: 'recorder', mimeType };
}

function isWebM(encoding: SupportedEncoding): boolean {
  return encoding.kind === 'recorder' && encoding.mimeType.startsWith('video/webm');
}

export function reelFileName(encoding: SupportedEncoding): string {
  return `deerdiary-reel.${isWebM(encoding) ? 'webm' : 'mp4'}`;
}

function coverScale(width: number, height: number): number {
  return Math.max(REEL_WIDTH / width, REEL_HEIGHT / height);
}

/** Decodes one photo at the largest size the drift needs, so eight originals fit in memory. */
async function reelImage(photo: Blob): Promise<ImageBitmap> {
  const full = await createImageBitmap(photo);
  try {
    const fit = Math.min(1, coverScale(full.width, full.height) * (1 + REEL_SCALE_DRIFT));
    return await createImageBitmap(full, {
      resizeWidth: Math.ceil(full.width * fit),
      resizeHeight: Math.ceil(full.height * fit),
      resizeQuality: 'high',
    });
  } finally {
    full.close();
  }
}

function drawEndCard(context: CanvasRenderingContext2D, card: ReelEndCardText) {
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, REEL_WIDTH, REEL_HEIGHT);
  context.fillStyle = FOREGROUND;
  context.textBaseline = 'middle';
  const height = TITLE_GAP_PX + (card.lines.length - 1) * LINE_GAP_PX;
  let y = (REEL_HEIGHT - height) / 2;
  context.font = TITLE_FONT;
  context.fillText(card.title, CARD_MARGIN_PX, y, REEL_WIDTH - 2 * CARD_MARGIN_PX);
  y += TITLE_GAP_PX;
  context.font = LINE_FONT;
  for (const line of card.lines) {
    context.fillText(line, CARD_MARGIN_PX, y, REEL_WIDTH - 2 * CARD_MARGIN_PX);
    y += LINE_GAP_PX;
  }
}

function drawFrame(
  context: CanvasRenderingContext2D,
  layers: readonly ReelLayer[],
  images: readonly ImageBitmap[],
  endCard: ReelEndCardText | null,
) {
  context.globalAlpha = 1;
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, REEL_WIDTH, REEL_HEIGHT);
  for (const { slide, opacity, scale } of layers) {
    context.globalAlpha = opacity;
    if (slide.kind === 'end') {
      if (endCard) drawEndCard(context, endCard);
      continue;
    }
    const image = images[slide.index];
    if (!image) continue;
    const fit = coverScale(image.width, image.height) * scale;
    const width = image.width * fit;
    const height = image.height * fit;
    context.drawImage(image, (REEL_WIDTH - width) / 2, (REEL_HEIGHT - height) / 2, width, height);
  }
}

async function encodeMp4(
  canvas: HTMLCanvasElement,
  draw: (timeMs: number) => void,
  durationMs: number,
  onProgress: (fraction: number) => void,
): Promise<Blob> {
  const { BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH } = await import(
    'mediabunny'
  );
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const source = new CanvasSource(canvas, {
    codec: 'avc',
    fullCodecString: REEL_H264_CODEC,
    quality: QUALITY_HIGH,
  });
  output.addVideoTrack(source, { frameRate: REEL_FRAME_RATE });
  try {
    await output.start();
    const frames = reelFrameCount(durationMs);
    for (let frame = 0; frame < frames; frame++) {
      draw((frame * 1000) / REEL_FRAME_RATE);
      await source.add(frame / REEL_FRAME_RATE, 1 / REEL_FRAME_RATE);
      onProgress((frame + 1) / frames);
    }
    await output.finalize();
  } catch (error) {
    await output.cancel();
    throw error;
  }
  if (!target.buffer) throw new Error('The MP4 writer finished without a file.');
  return new Blob([target.buffer], { type: 'video/mp4' });
}

/**
 * MediaRecorder leaves the duration out of a WebM header and records past the last frame, so the
 * recording is rewritten, without re-encoding, and cut at the reel's length.
 */
async function trimRecording(recording: Blob, durationMs: number): Promise<Blob> {
  const {
    BlobSource,
    BufferTarget,
    EncodedPacketSink,
    EncodedVideoPacketSource,
    Input,
    MP4,
    Mp4OutputFormat,
    Output,
    WEBM,
    WebMOutputFormat,
  } = await import('mediabunny');
  const webm = recording.type.startsWith('video/webm');
  const input = new Input({ source: new BlobSource(recording), formats: [webm ? WEBM : MP4] });
  try {
    const target = new BufferTarget();
    const output = new Output({
      format: webm ? new WebMOutputFormat() : new Mp4OutputFormat(),
      target,
    });
    const track = await input.getPrimaryVideoTrack();
    const codec = await track?.getCodec();
    const decoderConfig = await track?.getDecoderConfig();
    if (!track || !codec || !decoderConfig)
      throw new Error('The recorded reel has no readable video track.');
    const source = new EncodedVideoPacketSource(codec);
    output.addVideoTrack(source, { frameRate: REEL_FRAME_RATE });
    try {
      await output.start();
      for await (const packet of new EncodedPacketSink(track).packets()) {
        if (packet.timestamp >= durationMs / 1000) continue;
        await source.add(
          packet.clone({
            duration: Math.min(packet.duration, durationMs / 1000 - packet.timestamp),
          }),
          { decoderConfig },
        );
      }
      source.close();
      await output.finalize();
    } catch (error) {
      await output.cancel();
      throw error;
    }
    if (!target.buffer) throw new Error('The recorded reel was rewritten without a file.');
    return new Blob([target.buffer], { type: webm ? 'video/webm' : 'video/mp4' });
  } finally {
    input.dispose();
  }
}

async function recordReel(
  canvas: HTMLCanvasElement,
  draw: (timeMs: number) => void,
  durationMs: number,
  mimeType: string,
  onProgress: (fraction: number) => void,
): Promise<Blob> {
  const stream = canvas.captureStream(REEL_FRAME_RATE);
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks: Blob[] = [];
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });
  const stopped = new Promise<void>((resolve, reject) => {
    recorder.addEventListener('stop', () => resolve());
    recorder.addEventListener('error', () =>
      reject(new Error('The browser stopped recording the reel.')),
    );
  });
  draw(0);
  recorder.start();
  const startedMs = performance.now();
  // Timers rather than animation frames, so a hidden tab still finishes the recording.
  await new Promise<void>((resolve) => {
    const tick = () => {
      const elapsedMs = performance.now() - startedMs;
      draw(elapsedMs);
      onProgress(Math.min(1, elapsedMs / durationMs));
      if (elapsedMs >= durationMs) resolve();
      else setTimeout(tick, 1000 / REEL_FRAME_RATE);
    };
    tick();
  });
  recorder.stop();
  for (const track of stream.getTracks()) track.stop();
  await stopped;
  return trimRecording(new Blob(chunks, { type: recorder.mimeType || mimeType }), durationMs);
}

/** Draws the reel on a 1280 by 720 canvas and encodes it with the detected encoder. */
async function encodeReel(
  encoding: SupportedEncoding,
  { photos, endCard }: ReelVideo,
  onProgress: (fraction: number) => void,
): Promise<Blob> {
  const images: ImageBitmap[] = [];
  try {
    // One at a time, so only a single full-size original is decoded at once.
    for (const photo of photos) images.push(await reelImage(photo));
    const canvas = document.createElement('canvas');
    canvas.width = REEL_WIDTH;
    canvas.height = REEL_HEIGHT;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot draw the reel frames.');
    const includeEndCard = endCard !== null;
    const draw = (timeMs: number) =>
      drawFrame(context, reelLayers(timeMs, images.length, includeEndCard), images, endCard);
    const durationMs = reelDurationMs(images.length, includeEndCard);
    return encoding.kind === 'webcodecs'
      ? await encodeMp4(canvas, draw, durationMs, onProgress)
      : await recordReel(canvas, draw, durationMs, encoding.mimeType, onProgress);
  } finally {
    for (const image of images) image.close();
  }
}

function failureMessage(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `Could not export the reel. ${reason} Choose Export reel to try again.`;
}

/** Finds the browser's encoder once per page and exports one reel at a time. */
export function createReelExporter({
  loadPhoto,
  save,
  detect = detectReelEncoding,
  encode = encodeReel,
}: ReelExporterOptions) {
  const state = signal<ReelExportState>({ status: 'checking' });
  const encoding = detect().then((found) => {
    state.value = found.kind === 'unsupported' ? { status: 'unsupported' } : { status: 'ready' };
    return found;
  });

  return {
    state,
    async export({ paths, endCard }: ReelExportRequest): Promise<void> {
      const found = await encoding;
      if (found.kind === 'unsupported' || state.value.status === 'exporting') return;
      state.value = { status: 'exporting', percent: 0 };
      try {
        const photos: Blob[] = [];
        for (const path of paths) photos.push(await loadPhoto(path));
        const blob = await encode(found, { photos, endCard }, (fraction) => {
          const percent = Math.floor(fraction * 100);
          if (state.value.status === 'exporting' && state.value.percent !== percent) {
            state.value = { status: 'exporting', percent };
          }
        });
        save({ name: reelFileName(found), blob });
        state.value = { status: 'ready' };
      } catch (error) {
        state.value = { status: 'failed', message: failureMessage(error) };
      }
    },
  };
}

export type ReelExporter = ReturnType<typeof createReelExporter>;
