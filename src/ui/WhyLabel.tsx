import { displayName, explainSource, isPredictionSource, titleName } from '../core/explain';
import { type Classifications, classificationEntries } from '../core/labels';

// A night frame is lifted until its mean brightness reaches this, by at most the second.
const DISPLAY_MEAN = 0.42;
const DISPLAY_LIFT_MAX = 3;

export type WhyLabelDetection = {
  category: string;
  conf: number;
  bbox: readonly [number, number, number, number];
  label?: string | undefined;
  raw_classifications?: Classifications | undefined;
  processed_classification?: { class: string; score: number; source: string } | undefined;
};

export type WhyLabelProps = {
  detection: WhyLabelDetection;
  country?: string | undefined;
  imageURL?: string | undefined;
  /** The label the diary counted this box as, when its burst folded it into a narrower one. */
  countedAs?: string | undefined;
};

const DETECTOR_LABELS: Readonly<Record<string, string>> = {
  '1': 'animal',
  '2': 'human',
  '3': 'vehicle',
};

/** The detector's category as a word, falling back to the stored label on imported results. */
function detectorName(detection: WhyLabelDetection): string {
  return detection.label ?? DETECTOR_LABELS[detection.category] ?? detection.category;
}

/** Scores below one percent keep a decimal so a ranked list does not read as five zeros. */
export function scoreText(score: number): string {
  const value = score * 100;
  return value > 0 && value < 1 ? `${value.toFixed(1)}%` : `${Math.round(value)}%`;
}

// Labels the classifier gave under one percent are counted, not listed, so the list is not padding.
const LISTED_SCORE = 0.01;

/** The top five worth listing, and how many were left out for scoring under one percent. */
export function listedClasses(classes: readonly (readonly [string, number])[]) {
  const listed = classes.filter(([, score]) => score >= LISTED_SCORE);
  return { listed, hidden: classes.length - listed.length };
}

/**
 * A window around a detection box, in frame fractions: twice the box's longer side, never under
 * a fifth of the frame, kept inside it. Square in fractions, so it keeps the frame's own aspect.
 */
export function aroundBox([x, y, w, h]: readonly number[], scale = 2): [number, number, number] {
  const size = Math.min(1, Math.max(0.2, Math.max(w ?? 0, h ?? 0) * scale));
  const at = (start: number, length: number) =>
    Math.min(1 - size, Math.max(0, start + length / 2 - size / 2));
  return [at(x ?? 0, w ?? 0), at(y ?? 0, h ?? 0), size];
}

/** The stored top five, in the order the classifier ranked them. */
export function topClasses(detection: WhyLabelDetection): readonly (readonly [string, number])[] {
  const raw = detection.raw_classifications;
  if (raw === undefined || raw.classes.length === 0 || raw.classes.length !== raw.scores.length)
    return [];
  if (!raw.scores.every((score) => Number.isFinite(score) && score >= 0 && score <= 1)) return [];
  return classificationEntries(raw).slice(0, 5);
}

/**
 * Sentences for the stored result only. Imported files may name a source or carry scores this
 * build does not know, so the popover stays empty instead of inventing an explanation.
 */
export function whyLabelSentences(
  detection: WhyLabelDetection,
  country: string | undefined,
): string[] {
  const processed = detection.processed_classification;
  const raw = detection.raw_classifications;
  if (
    processed === undefined ||
    raw === undefined ||
    !isPredictionSource(processed.source) ||
    topClasses(detection).length === 0
  )
    return [];
  return explainSource(processed.source, {
    classification: raw,
    detector: { label: detectorName(detection), conf: detection.conf },
    country,
  });
}

/** Says why a card counts a box under a label other than its own. */
export function countedAsSentence(countedAs: string): string {
  return `The diary counted it with ${displayName(countedAs)} because the same burst identified it.`;
}

type CropProps = {
  src: string;
  detection: WhyLabelDetection;
  name: string;
};

/** How far to brighten a photo for display so a night frame reads: up to three times, never darker. */
export function displayLift(image: HTMLImageElement): number {
  const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!context || !image.naturalWidth) return 1;
  context.canvas.width = 32;
  context.canvas.height = 32;
  context.drawImage(image, 0, 0, 32, 32);
  let rgba: Uint8ClampedArray;
  try {
    rgba = context.getImageData(0, 0, 32, 32).data;
  } catch {
    // A photo from another origin cannot be read; it is shown as it is.
    return 1;
  }
  let sum = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    sum += 0.2126 * (rgba[i] ?? 0) + 0.7152 * (rgba[i + 1] ?? 0) + 0.0722 * (rgba[i + 2] ?? 0);
  }
  const mean = sum / (rgba.length / 4) / 255;
  return Math.min(DISPLAY_LIFT_MAX, Math.max(1, DISPLAY_MEAN / Math.max(mean, 0.01)));
}

/** Brightens a loaded photo for display only; the stored photo is unchanged. */
export function lift(event: { currentTarget: HTMLImageElement }) {
  event.currentTarget.style.filter = `brightness(${displayLift(event.currentTarget)})`;
}

/**
 * The crop shows the detection with as much ground again around it, since a night animal alone in
 * its box reads as noise; the image is scaled and offset so that window fills the frame.
 */
function Crop({ src, detection, name }: CropProps) {
  const [left, top, size] = aroundBox(detection.bbox);
  return (
    <span class="crop">
      <img
        src={src}
        alt={`Crop of ${name}`}
        onLoad={lift}
        style={{
          left: `${(-left / size) * 100}%`,
          top: `${(-top / size) * 100}%`,
          width: `${100 / size}%`,
          height: `${100 / size}%`,
        }}
      />
    </span>
  );
}

/** Why a box has its label: the stored crop, the classifier's top five and the rule that decided. */
export function WhyLabel({ detection, country, imageURL, countedAs }: WhyLabelProps) {
  const { listed: classes, hidden } = listedClasses(topClasses(detection));
  const sentences = whyLabelSentences(detection, country);
  const processed = detection.processed_classification;
  const name = processed === undefined ? 'the detection' : displayName(processed.class);

  return (
    <section aria-label={`Why ${name} has this label`}>
      {imageURL === undefined ? (
        <p>Photo unavailable.</p>
      ) : (
        <Crop src={imageURL} detection={detection} name={name} />
      )}
      <h3>Classifier's top five</h3>
      {classes.length === 0 && hidden === 0 ? (
        <p>No classifier scores were stored for this detection.</p>
      ) : (
        <ol>
          {classes.map(([label, score]) => (
            <li key={label}>
              {titleName(label)} ({scoreText(score)})
            </li>
          ))}
        </ol>
      )}
      {hidden > 0 && <p class="hidden-count">{hidden} more under 1%.</p>}
      {/* One sentence: the rule that decided, or how the burst counted it, never the figures again. */}
      {(countedAs ?? sentences.at(-1)) !== undefined && (
        <p>{countedAs === undefined ? sentences.at(-1) : countedAsSentence(countedAs)}</p>
      )}
    </section>
  );
}
