import { useState } from 'preact/hooks';

const count = new Intl.NumberFormat('en-US');

const HOURS = 24;
const INNER_RADIUS = 26;
const OUTER_RADIUS = 96;
const DIAL_MARKS = [
  { hour: 0, x: 0, y: -102, anchor: 'middle' },
  { hour: 6, x: 102, y: 3, anchor: 'start' },
  { hour: 12, x: 0, y: 108, anchor: 'middle' },
  { hour: 18, x: -102, y: 3, anchor: 'end' },
] as const;

/** Camera hours read as wall-clock hours, so midnight and noon need explicit names. */
function hourLabel(hour: number): string {
  if (hour === 0) return '12 am';
  if (hour === 12) return '12 pm';
  return hour < 12 ? `${hour} am` : `${hour - 12} pm`;
}

/** The live readout names the selected hour and its count in one phrase. */
export function clockReadout(hour: number, detections: number): string {
  return `${hourLabel(hour)}: ${count.format(detections)} ${
    detections === 1 ? 'detection' : 'detections'
  }`;
}

/** A spoke's share of the widest hour, clamped so one busy hour cannot outgrow the chart. */
export function spokeFraction(detections: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(1, Math.max(0, detections / max));
}

/** Arrows and Home/End walk the circular day; other keys keep their own behaviour. */
export function nextClockHour(hour: number, key: string): number | null {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (hour + 1) % HOURS;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (hour + HOURS - 1) % HOURS;
    case 'Home':
      return 0;
    case 'End':
      return HOURS - 1;
    default:
      return null;
  }
}

function point(hour: number, radius: number): { x: number; y: number } {
  // Midnight sits at the top and the day runs clockwise.
  const angle = (hour / HOURS) * Math.PI * 2 - Math.PI / 2;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

export type ClockProps = {
  /** Hourly detection counts, as returned by hourBins. */
  bins: readonly number[];
  label?: string | undefined;
};

/**
 * One tab stop for the whole chart keeps 24 hours out of the tab order; arrow keys move the
 * selected hour and a polite readout names it. The hidden table carries every value for
 * assistive technology that cannot use the drawing.
 */
export function Clock({ bins, label = 'Detections by hour' }: ClockProps) {
  const counts = Array.from({ length: HOURS }, (_, hour) => bins[hour] ?? 0);
  const max = Math.max(...counts);
  const [hour, setHour] = useState(0);
  const detections = counts[hour] ?? 0;
  const readout = clockReadout(hour, detections);

  return (
    <section class="clock" aria-label={label}>
      <h2>Activity clock</h2>
      <div
        class="clock-dial"
        role="slider"
        tabIndex={0}
        aria-label={`${label}, use the arrow keys to read each hour`}
        aria-valuemin={0}
        aria-valuemax={HOURS - 1}
        aria-valuenow={hour}
        aria-valuetext={readout}
        onKeyDown={(event) => {
          const next = nextClockHour(hour, event.key);
          if (next === null) return;
          event.preventDefault();
          setHour(next);
        }}
      >
        <svg viewBox="-128 -112 256 224" width="256" height="224" aria-hidden="true">
          {counts.map((value, index) => {
            const start = point(index, INNER_RADIUS);
            const end = point(
              index,
              INNER_RADIUS + spokeFraction(value, max) * (OUTER_RADIUS - INNER_RADIUS),
            );
            const selected = index === hour;
            return (
              <line
                class={selected ? 'spoke is-selected' : 'spoke'}
                key={index}
                x1={start.x}
                y1={start.y}
                x2={end.x}
                y2={end.y}
              />
            );
          })}
          <circle class="ring" r={INNER_RADIUS - 4} />
          {DIAL_MARKS.map(({ hour, x, y, anchor }) => (
            <text key={hour} class="mark" x={x} y={y} text-anchor={anchor}>
              {hourLabel(hour)}
            </text>
          ))}
        </svg>
      </div>
      <p class="clock-readout" aria-live="polite">
        {readout}
      </p>
      <table hidden>
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">Hour</th>
            <th scope="col">Detections</th>
          </tr>
        </thead>
        <tbody>
          {counts.map((value, index) => (
            <tr key={index}>
              <th scope="row">{hourLabel(index)}</th>
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
