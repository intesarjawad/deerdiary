import { aviFrameBlob, parseAvi } from '../core/avi';
import { type CameraTime, clockStatus, fileWallClockMs } from '../core/time';
import type { ScannedFile } from './scan';

export const VIDEO_MAX_FRAMES = 10;
// Container sniffing reads only the ends of a file, where MP4 keeps its sample descriptions.
const SNIFF_BYTES = 1 << 20;
const HEVC_MARKERS = ['hvc1', 'hev1', 'hvcC'];

export type VideoFrames =
  | { status: 'ok'; frames: ImageBitmap[] }
  | { status: 'unsupported_codec'; codec: string }
  | { status: 'decode_failed' };

/** One sample per second of footage, at least one and at most `max`. */
export function sampleSeconds(durationSec: number, max = VIDEO_MAX_FRAMES): number[] {
  const wanted = Number.isFinite(durationSec) ? Math.ceil(durationSec) : 1;
  return Array.from({ length: Math.min(max, Math.max(1, wanted)) }, (_, second) => second);
}

/** True when an MP4-family byte range names an HEVC sample entry or its configuration box. */
export function containsHevcMarker(bytes: Uint8Array): boolean {
  const text = new TextDecoder('latin1').decode(bytes);
  return HEVC_MARKERS.some((marker) => text.includes(marker));
}

/** Videos carry no EXIF the app reads, so their time is the file's own. */
export function videoCameraTime(scanned: ScannedFile, dropWallClockMs: number): CameraTime {
  const wallClockMs = fileWallClockMs(scanned.mtimeMs);
  return {
    wallClockMs,
    wallClockHour: new Date(wallClockMs).getUTCHours(),
    timeSource: 'file',
    offsetTimeOriginal: null,
    clockStatus: clockStatus(wallClockMs, dropWallClockMs),
  };
}

async function sniffCodec(file: File): Promise<string> {
  const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  const tail = new Uint8Array(await file.slice(Math.max(0, file.size - SNIFF_BYTES)).arrayBuffer());
  return containsHevcMarker(head) || containsHevcMarker(tail) ? 'hevc' : 'unknown';
}

function settled(video: HTMLVideoElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      video.removeEventListener(event, onEvent);
      video.removeEventListener('error', onError);
    };
    const onEvent = () => {
      done();
      resolve();
    };
    const onError = () => {
      done();
      reject(video.error ?? new Error('Video failed to load'));
    };
    video.addEventListener(event, onEvent);
    video.addEventListener('error', onError);
  });
}

function isSourceNotSupported(error: unknown): boolean {
  return error instanceof MediaError && error.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED;
}

async function elementFrames(file: File): Promise<VideoFrames> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  const frames: ImageBitmap[] = [];
  try {
    const loaded = settled(video, 'loadeddata');
    video.src = url;
    await loaded;
    // A browser without the HEVC decoder can still load such a file's audio track.
    if (video.videoWidth === 0 || video.videoHeight === 0)
      return { status: 'unsupported_codec', codec: await sniffCodec(file) };
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) return { status: 'decode_failed' };
    for (const second of sampleSeconds(video.duration)) {
      if (Math.abs(video.currentTime - second) > 1e-3) {
        const seeked = settled(video, 'seeked');
        video.currentTime = second;
        await seeked;
      }
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push(await createImageBitmap(canvas));
    }
    return { status: 'ok', frames };
  } catch (error) {
    for (const frame of frames) frame.close();
    return isSourceNotSupported(error)
      ? { status: 'unsupported_codec', codec: await sniffCodec(file) }
      : { status: 'decode_failed' };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

async function aviFrames(file: File): Promise<VideoFrames> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const clip = parseAvi(bytes);
  if (clip.status === 'unsupported_handler')
    return { status: 'unsupported_codec', codec: clip.fourcc };
  if (clip.status === 'invalid') return { status: 'decode_failed' };
  const durationSec = (clip.frames.length * clip.microSecPerFrame) / 1_000_000;
  const frames: ImageBitmap[] = [];
  try {
    for (const second of sampleSeconds(durationSec)) {
      const index = Math.min(
        clip.frames.length - 1,
        Math.floor((second * 1_000_000) / clip.microSecPerFrame),
      );
      const frame = clip.frames[index];
      if (frame) frames.push(await createImageBitmap(aviFrameBlob(bytes, frame)));
    }
    return { status: 'ok', frames };
  } catch {
    for (const frame of frames) frame.close();
    return { status: 'decode_failed' };
  }
}

/** Samples a clip at one frame per second, never throwing for undecodable files. */
export async function extractVideoFrames(file: File): Promise<VideoFrames> {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const isAvi =
    String.fromCharCode(...head.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...head.subarray(8, 12)) === 'AVI ';
  return isAvi ? aviFrames(file) : elementFrames(file);
}
