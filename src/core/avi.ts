export type AviFrame = { offset: number; length: number };

export type AviClip = {
  status: 'ok';
  microSecPerFrame: number;
  width: number;
  height: number;
  handler: string;
  frames: readonly AviFrame[];
  // The file ends inside the frame data or declares more bytes than it holds.
  truncated: boolean;
};

export type AviParse =
  | AviClip
  | { status: 'unsupported_handler'; fourcc: string }
  | { status: 'invalid'; reason: string };

type Chunk = { id: string; start: number; end: number; complete: boolean };

const AVIH_MIN_BYTES = 40;
const STRH_MIN_BYTES = 28;
const INDEX_ENTRY_BYTES = 16;

function fourcc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + 4));
}

/** Walks sibling chunks, clamping the last one to `limit` and flagging it as incomplete. */
function* chunksOf(
  bytes: Uint8Array,
  view: DataView,
  from: number,
  limit: number,
): Generator<Chunk> {
  let at = from;
  while (at + 8 <= limit) {
    const start = at + 8;
    const end = start + view.getUint32(at + 4, true);
    const complete = end <= limit;
    yield { id: fourcc(bytes, at), start, end: Math.min(end, limit), complete };
    if (!complete) return;
    // RIFF chunks are word aligned.
    at = end + (end & 1);
  }
}

function moviFrames(
  bytes: Uint8Array,
  view: DataView,
  movi: Chunk,
  chunkId: string,
): { frames: AviFrame[]; truncated: boolean } {
  const frames: AviFrame[] = [];
  let truncated = false;
  const scan = (from: number, limit: number) => {
    for (const chunk of chunksOf(bytes, view, from, limit)) {
      if (!chunk.complete) truncated = true;
      if (chunk.id === 'LIST' && fourcc(bytes, chunk.start) === 'rec ') {
        scan(chunk.start + 4, chunk.end);
      } else if (chunk.complete && chunk.id === chunkId && chunk.end > chunk.start) {
        frames.push({ offset: chunk.start, length: chunk.end - chunk.start });
      }
    }
  };
  scan(movi.start + 4, movi.end);
  return { frames, truncated };
}

/** Reads the `idx1` table, or returns undefined when it does not describe real chunks. */
function indexedFrames(
  bytes: Uint8Array,
  view: DataView,
  idx1: Chunk,
  moviTypeAt: number,
  chunkId: string,
): { frames: AviFrame[]; truncated: boolean } | undefined {
  const entries: { offset: number; size: number }[] = [];
  for (let at = idx1.start; at + INDEX_ENTRY_BYTES <= idx1.end; at += INDEX_ENTRY_BYTES) {
    if (fourcc(bytes, at) === chunkId)
      entries.push({ offset: view.getUint32(at + 8, true), size: view.getUint32(at + 12, true) });
  }
  const first = entries[0];
  if (!first) return undefined;
  // Offsets are relative to the `movi` type code, though some writers store absolute positions.
  const base = [moviTypeAt, 0].find(
    (candidate) =>
      candidate + first.offset + 8 <= bytes.length &&
      fourcc(bytes, candidate + first.offset) === chunkId,
  );
  if (base === undefined) return undefined;
  const frames: AviFrame[] = [];
  let truncated = false;
  for (const entry of entries) {
    const header = base + entry.offset;
    if (header + 8 > bytes.length) {
      truncated = true;
      break;
    }
    if (fourcc(bytes, header) !== chunkId) return undefined;
    if (header + 8 + entry.size > bytes.length) {
      truncated = true;
      break;
    }
    if (entry.size > 0) frames.push({ offset: header + 8, length: entry.size });
  }
  return { frames, truncated };
}

/** Parses an AVI container's first video stream, tolerating a file cut short. */
export function parseAvi(bytes: Uint8Array): AviParse {
  if (bytes.length < 12 || fourcc(bytes, 0) !== 'RIFF' || fourcc(bytes, 8) !== 'AVI ')
    return { status: 'invalid', reason: 'not an AVI file' };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declaredEnd = 8 + view.getUint32(4, true);
  const limit = Math.min(bytes.length, declaredEnd);
  let microSecPerFrame = 0;
  let width = 0;
  let height = 0;
  let handler: string | undefined;
  let videoStream = -1;
  let streams = 0;
  let movi: Chunk | undefined;
  let idx1: Chunk | undefined;
  for (const top of chunksOf(bytes, view, 12, limit)) {
    if (top.id === 'idx1') idx1 = top;
    if (top.id !== 'LIST') continue;
    const type = fourcc(bytes, top.start);
    if (type === 'movi') movi = top;
    if (type !== 'hdrl') continue;
    for (const header of chunksOf(bytes, view, top.start + 4, top.end)) {
      if (header.id === 'avih' && header.end - header.start >= AVIH_MIN_BYTES) {
        microSecPerFrame = view.getUint32(header.start, true);
        width = view.getUint32(header.start + 32, true);
        height = view.getUint32(header.start + 36, true);
      } else if (header.id === 'LIST' && fourcc(bytes, header.start) === 'strl') {
        for (const field of chunksOf(bytes, view, header.start + 4, header.end)) {
          if (field.id !== 'strh' || field.end - field.start < STRH_MIN_BYTES) continue;
          if (handler === undefined && fourcc(bytes, field.start) === 'vids') {
            handler = fourcc(bytes, field.start + 4);
            videoStream = streams;
            if (microSecPerFrame === 0) {
              const scale = view.getUint32(field.start + 20, true);
              const rate = view.getUint32(field.start + 24, true);
              if (rate > 0) microSecPerFrame = Math.round((scale * 1_000_000) / rate);
            }
          }
        }
        streams++;
      }
    }
  }
  if (handler === undefined) return { status: 'invalid', reason: 'no video stream' };
  if (handler.toUpperCase() !== 'MJPG') return { status: 'unsupported_handler', fourcc: handler };
  if (microSecPerFrame === 0) return { status: 'invalid', reason: 'no frame rate' };
  if (!movi) return { status: 'invalid', reason: 'no movi list' };
  const chunkId = `${String(videoStream).padStart(2, '0')}dc`;
  const indexed = idx1 ? indexedFrames(bytes, view, idx1, movi.start, chunkId) : undefined;
  const { frames, truncated } = indexed ?? moviFrames(bytes, view, movi, chunkId);
  if (frames.length === 0) return { status: 'invalid', reason: 'no video frames' };
  return {
    status: 'ok',
    microSecPerFrame,
    width,
    height,
    handler,
    frames,
    truncated: truncated || declaredEnd > bytes.length,
  };
}

/** Copies one frame out of the file as a JPEG for `createImageBitmap`. */
export function aviFrameBlob(bytes: Uint8Array, frame: AviFrame): Blob {
  return new Blob([bytes.slice(frame.offset, frame.offset + frame.length)], { type: 'image/jpeg' });
}
