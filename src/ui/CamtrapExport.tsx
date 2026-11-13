import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import {
  type CamtrapDraft,
  type CamtrapMetadata,
  SAMPLING_DESIGNS,
  validateCamtrapDraft,
} from '../core/camtrapMetadata';

export type CamtrapExportProps = {
  cameras: readonly string[];
  initial: CamtrapDraft;
  memoryOnly: boolean;
  onSave: (draft: CamtrapDraft) => Promise<void>;
  onDownload: (metadata: CamtrapMetadata) => void;
  onClose: () => void;
};

/** Collects the metadata the camera files cannot supply, beside the existing downloads. */
export function CamtrapExport({
  cameras,
  initial,
  memoryOnly,
  onSave,
  onDownload,
  onClose,
}: CamtrapExportProps) {
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState(initial);
  const [submitted, setSubmitted] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const validation = validateCamtrapDraft(draft, cameras);
  const errors = submitted && !validation.ok ? validation.errors : {};
  useLayoutEffect(() => {
    form.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, []);

  function change(next: CamtrapDraft) {
    setDraft(next);
    setMessage(null);
    void onSave(next).catch((cause: unknown) => {
      setMessage(
        `Could not save export details. ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    });
  }

  function field(name: string, label: string, value: string, onInput: (value: string) => void) {
    const fieldId = `${id}-${name}`;
    return (
      <div class="camtrap-field">
        <label for={fieldId}>{label}</label>
        <input
          id={fieldId}
          name={name}
          type="text"
          value={value}
          required
          aria-invalid={Boolean(errors[name])}
          aria-describedby={errors[name] ? `${fieldId}-error` : undefined}
          onInput={(event) => onInput(event.currentTarget.value)}
        />
        {errors[name] && (
          <span class="camtrap-error" id={`${fieldId}-error`}>
            {errors[name]}
          </span>
        )}
      </div>
    );
  }

  return (
    <form
      ref={form}
      class="camtrap-form"
      aria-label="Camtrap DP export details"
      noValidate
      onSubmit={async (event) => {
        event.preventDefault();
        setSubmitted(true);
        setMessage(null);
        if (!validation.ok) {
          requestAnimationFrame(() =>
            form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
          );
          return;
        }
        setSaving(true);
        try {
          await onSave(draft);
          onDownload(validation.metadata);
          setMessage('Camtrap DP downloaded. Keep all four files in one folder.');
        } catch (cause) {
          setMessage(
            `Could not export Camtrap DP. ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        } finally {
          setSaving(false);
        }
      }}
    >
      <h3>Camtrap DP export details</h3>
      <p>
        Enter the project details and where each camera stood. Coordinates use WGS84 decimal
        degrees.
      </p>
      <fieldset disabled={saving}>
        <legend>Project</legend>
        <div class="camtrap-fields">
          {field('projectTitle', 'Project title', draft.projectTitle, (projectTitle) =>
            change({ ...draft, projectTitle }),
          )}
          {field('contributor', 'Contributor name', draft.contributor, (contributor) =>
            change({ ...draft, contributor }),
          )}
          <div class="camtrap-field">
            <label for={`${id}-sampling`}>Sampling design</label>
            <select
              id={`${id}-sampling`}
              value={draft.samplingDesign}
              required
              aria-invalid={Boolean(errors.samplingDesign)}
              aria-describedby={errors.samplingDesign ? `${id}-sampling-error` : undefined}
              onChange={(event) => change({ ...draft, samplingDesign: event.currentTarget.value })}
            >
              <option value="">Choose sampling design</option>
              {SAMPLING_DESIGNS.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            {errors.samplingDesign && (
              <span class="camtrap-error" id={`${id}-sampling-error`}>
                {errors.samplingDesign}
              </span>
            )}
          </div>
        </div>
        <p>
          <label>
            <input
              type="checkbox"
              checked={draft.individualAnimals}
              onChange={(event) =>
                change({ ...draft, individualAnimals: event.currentTarget.checked })
              }
            />{' '}
            The project recognizes individual animals
          </label>
        </p>
      </fieldset>
      {cameras.map((camera) => {
        const coordinates = draft.locations[camera] ?? { latitude: '', longitude: '' };
        return (
          <fieldset key={camera} disabled={saving}>
            <legend>Camera folder: {camera}</legend>
            <div class="camtrap-fields">
              {field(
                `latitude:${camera}`,
                `Latitude for ${camera}`,
                coordinates.latitude,
                (latitude) =>
                  change({
                    ...draft,
                    locations: { ...draft.locations, [camera]: { ...coordinates, latitude } },
                  }),
              )}
              {field(
                `longitude:${camera}`,
                `Longitude for ${camera}`,
                coordinates.longitude,
                (longitude) =>
                  change({
                    ...draft,
                    locations: { ...draft.locations, [camera]: { ...coordinates, longitude } },
                  }),
              )}
            </div>
          </fieldset>
        );
      })}
      {submitted && !validation.ok && (
        <p role="alert">Check the fields marked below their labels. No files were downloaded.</p>
      )}
      {memoryOnly && (
        <p role="status">
          These details are kept in this tab only because browser storage is unavailable.
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <p class="actions">
        <button class="primary" type="submit" disabled={saving}>
          {saving ? 'Saving details…' : 'Download package'}
        </button>{' '}
        <button type="button" disabled={saving} onClick={onClose}>
          Close export details
        </button>
      </p>
    </form>
  );
}
