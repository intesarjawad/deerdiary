import type { ComponentChildren } from 'preact';
import type { Progress as PipelineProgress } from '../app/state';

const count = new Intl.NumberFormat('en-US');

export type ProgressProps = {
  progress: PipelineProgress;
  children?: ComponentChildren;
};

/** Renders the live photo count; callers place the country selector inside the same line. */
export function Progress({ progress, children }: ProgressProps) {
  const { done, total, photosPerSecond, secondsLeft } = progress;

  return (
    <p class="rail" role="status" data-idle={total === 0}>
      <span>
        {count.format(done)} / {count.format(total)} photos
      </span>
      {photosPerSecond > 0 && <span> · {photosPerSecond.toFixed(1)} photos/s</span>}
      {secondsLeft !== null && secondsLeft > 0 && (
        <span> · about {Math.ceil(secondsLeft)} s left</span>
      )}
      {total > 0 && done < total && (
        <span class="bar" aria-hidden="true">
          <span style={{ transform: `scaleX(${Math.min(done / total, 1)})` }} />
        </span>
      )}
      {children && <span> {children}</span>}
    </p>
  );
}
