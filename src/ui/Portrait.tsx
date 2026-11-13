import { useLayoutEffect, useRef, useState } from 'preact/hooks';

type Box = readonly [number, number, number, number];

/** Below this many source pixels a box is too small to enlarge without inventing detail. */
export const TINY_SUBJECT_PX = 48;

export type Crop = {
  /** `crop` fills the frame with the animal; `whole` keeps the frame and marks the animal. */
  mode: 'crop' | 'whole';
  left: number;
  top: number;
  width: number;
  height: number;
};

/**
 * Places the source image inside a `cw` by `ch` window. A subject of at least TINY_SUBJECT_PX is
 * enlarged until it fills about half the window; a smaller one is never enlarged, the whole frame
 * is shown instead so the viewer sees how little the camera caught.
 */
export function cropGeometry(
  cw: number,
  ch: number,
  natural: { width: number; height: number },
  [x, y, w, h]: Box,
): Crop {
  const { width: W, height: H } = natural;
  const cover = Math.max(cw / W, ch / H);
  const subject = Math.max(w * W, h * H);
  const place = (scale: number, cx: number, cy: number): Omit<Crop, 'mode'> => {
    const width = W * scale;
    const height = H * scale;
    return {
      width,
      height,
      left: Math.min(0, Math.max(cw - width, cw / 2 - cx * scale)),
      top: Math.min(0, Math.max(ch - height, ch / 2 - cy * scale)),
    };
  };
  if (subject < TINY_SUBJECT_PX) return { mode: 'whole', ...place(cover, W / 2, H / 2) };
  const fill = 0.5 * Math.min(cw / (w * W), ch / (h * H));
  return { mode: 'crop', ...place(Math.max(fill, cover), (x + w / 2) * W, (y + h / 2) * H) };
}

export function useNatural(): [{ width: number; height: number } | null, (event: Event) => void] {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  return [
    size,
    (event) => {
      const image = event.currentTarget as HTMLImageElement;
      setSize({ width: image.naturalWidth, height: image.naturalHeight });
    },
  ];
}

const LOUPE = 120;

/** One animal, large: a sharp crop, or the whole frame with a loupe when the subject is tiny. */
export function Portrait({ src, box, label }: { src: string; box: Box; label: string }) {
  const frame = useRef<HTMLDivElement>(null);
  const [window, setWindow] = useState({ cw: 0, ch: 0 });
  const [natural, onLoad] = useNatural();
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWindow({ cw: entry.contentRect.width, ch: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const crop =
    natural && window.cw > 0 ? cropGeometry(window.cw, window.ch, natural, box) : undefined;
  const [x, y, w, h] = box;
  const boxPx = crop && {
    left: crop.left + x * crop.width,
    top: crop.top + y * crop.height,
    width: w * crop.width,
    height: h * crop.height,
  };
  const loupeLeft = boxPx
    ? Math.min(Math.max(boxPx.left + boxPx.width / 2 + 28, 8), window.cw - LOUPE - 8)
    : 0;
  const loupeTop = boxPx
    ? Math.min(Math.max(boxPx.top + boxPx.height / 2 - LOUPE - 28, 8), window.ch - LOUPE - 8)
    : 0;
  return (
    <div
      class="portrait"
      ref={frame}
      data-mode={crop?.mode ?? 'crop'}
      role="img"
      aria-label={label}
    >
      <img
        src={src}
        alt=""
        decoding="async"
        onLoad={onLoad}
        style={
          crop
            ? {
                width: `${crop.width}px`,
                height: `${crop.height}px`,
                left: `${crop.left}px`,
                top: `${crop.top}px`,
              }
            : undefined
        }
      />
      {crop?.mode === 'whole' && boxPx && (
        <>
          <span class="portrait-box" style={boxPx} />
          <span class="portrait-loupe" style={{ left: `${loupeLeft}px`, top: `${loupeTop}px` }}>
            <img
              src={src}
              alt=""
              style={{
                width: `${crop.width * 2}px`,
                height: `${crop.height * 2}px`,
                left: `${LOUPE / 2 - (x + w / 2) * crop.width * 2}px`,
                top: `${LOUPE / 2 - (y + h / 2) * crop.height * 2}px`,
              }}
            />
          </span>
        </>
      )}
    </div>
  );
}
