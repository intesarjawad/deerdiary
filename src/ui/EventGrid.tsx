import { useEffect, useRef, useState } from 'preact/hooks';
import { burstCounter } from '../core/events';
import type { DeerdiaryEvent, Detection, PhotoResult } from '../core/types';

const cameraTime = new Intl.DateTimeFormat('en', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

/** Camera readings are wall-clock values encoded in UTC, so they must not be shifted again. */
export function formatCameraTime(wallClockMs: number): string {
  return cameraTime.format(wallClockMs);
}

const burstTime = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
});

/** The short caption of a burst thumbnail: no year, one line. */
export function formatBurstTime(wallClockMs: number): string {
  return burstTime.format(wallClockMs).replace(', ', ' · ');
}

function matchingDetections(
  photo: PhotoResult,
  event: DeerdiaryEvent,
  labels: readonly string[],
): Detection[] {
  const counted = burstCounter(event.photos);
  return photo.detections.filter((detection) => {
    const label = counted(detection);
    return label !== undefined && labels.includes(label);
  });
}

function bestSpeciesPhoto(
  event: DeerdiaryEvent,
  labels: readonly string[],
): PhotoResult | undefined {
  for (const species of event.species) {
    if (labels.includes(species.label)) return species.bestPhoto;
  }
  return event.photos[0];
}

export type DetectionBoxesProps = {
  photo: PhotoResult;
  /** The burst the photo belongs to, which decides the label each box counts as. */
  event: DeerdiaryEvent;
  labels: readonly string[];
};

/** Positions outlines over an image whose wrapper is the same aspect ratio as the photo. */
export function DetectionBoxes({ photo, event, labels }: DetectionBoxesProps) {
  return (
    <>
      {matchingDetections(photo, event, labels).map((detection, index) => (
        <span
          aria-hidden="true"
          key={`${detection.processed_classification?.class ?? 'box'}-${index}`}
          class="box"
          style={{
            left: `${detection.bbox[0] * 100}%`,
            top: `${detection.bbox[1] * 100}%`,
            width: `${detection.bbox[2] * 100}%`,
            height: `${detection.bbox[3] * 100}%`,
          }}
        />
      ))}
    </>
  );
}

type SelectedPhoto = { event: DeerdiaryEvent; photo: PhotoResult };

export type EventGridProps = {
  events: readonly DeerdiaryEvent[];
  labels: readonly string[];
  name?: string | undefined;
  thumbnailURL?: ((path: string) => string | undefined) | undefined;
  photoURL?: ((path: string) => string | undefined) | undefined;
};

/** One thumbnail per burst, with the full frame and its boxes opened in a modal dialog. */
export function EventGrid({ events, labels, name, thumbnailURL, photoURL }: EventGridProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const [selected, setSelected] = useState<SelectedPhoto | null>(null);

  useEffect(() => {
    if (selected) dialog.current?.showModal();
  }, [selected]);

  function close() {
    dialog.current?.close();
  }

  function restoreFocus() {
    setSelected(null);
    const trigger = returnFocus.current;
    returnFocus.current = null;
    trigger?.focus();
  }

  function open(event: DeerdiaryEvent, photo: PhotoResult, trigger: HTMLButtonElement) {
    returnFocus.current = trigger;
    setSelected({ event, photo });
  }

  if (events.length === 0) return null;

  function movePhoto(step: number) {
    if (!selected) return;
    const index = selected.event.photos.indexOf(selected.photo);
    const photo = selected.event.photos[index + step];
    if (photo) setSelected({ event: selected.event, photo });
  }

  const selectedSource =
    selected === null
      ? undefined
      : (photoURL?.(selected.photo.path) ?? thumbnailURL?.(selected.photo.path));

  return (
    <section class="bursts" aria-label={`Events for ${name ?? 'this species'}`}>
      <ul class="burst-list">
        {events.map((event) => {
          const photo = bestSpeciesPhoto(event, labels);
          if (!photo) return null;
          const time = formatCameraTime(photo.time.wallClockMs);
          const photoLabel =
            event.photos.length === 1 ? '1 photo' : `${event.photos.length} photos`;
          const thumbnail = thumbnailURL?.(photo.path);
          return (
            <li key={`${event.cameraKey}-${photo.path}`}>
              <button
                type="button"
                aria-label={`Open photo from ${time}, ${photoLabel} in this event`}
                onClick={(click) => open(event, photo, click.currentTarget)}
              >
                {thumbnail ? (
                  <span class="frame">
                    <img src={thumbnail} alt="" />
                    <DetectionBoxes photo={photo} event={event} labels={labels} />
                  </span>
                ) : (
                  <span class="blank">Photo</span>
                )}
                <span class="strip">
                  {formatBurstTime(photo.time.wallClockMs)}
                  <span class="vh">
                    , {event.photos.length} {event.photos.length === 1 ? 'photo' : 'photos'}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <dialog
        ref={dialog}
        aria-label={
          selected ? `Photo from ${formatCameraTime(selected.photo.time.wallClockMs)}` : 'Photo'
        }
        onClose={restoreFocus}
        class="viewer"
      >
        {selected && (
          <>
            <p>
              <button type="button" onClick={close}>
                Close
              </button>
            </p>
            <h3>{formatCameraTime(selected.photo.time.wallClockMs)}</h3>
            {selectedSource ? (
              <span class="frame">
                <img
                  src={selectedSource}
                  alt={`Trail camera frame from ${formatCameraTime(selected.photo.time.wallClockMs)}`}
                />
                <DetectionBoxes photo={selected.photo} event={selected.event} labels={labels} />
              </span>
            ) : (
              <p>Full photo unavailable.</p>
            )}
            {selected.event.photos.length > 1 && (
              <div class="actions">
                <button
                  type="button"
                  disabled={selected.event.photos.indexOf(selected.photo) === 0}
                  onClick={() => movePhoto(-1)}
                >
                  Previous photo
                </button>
                <span role="status">
                  Photo {selected.event.photos.indexOf(selected.photo) + 1} of{' '}
                  {selected.event.photos.length}
                </span>
                <button
                  type="button"
                  disabled={
                    selected.event.photos.indexOf(selected.photo) ===
                    selected.event.photos.length - 1
                  }
                  onClick={() => movePhoto(1)}
                >
                  Next photo
                </button>
              </div>
            )}
            <p>
              {selected.event.photos.length === 1
                ? '1 photo in this event.'
                : `${selected.event.photos.length} photos in this event.`}
            </p>
          </>
        )}
      </dialog>
    </section>
  );
}
