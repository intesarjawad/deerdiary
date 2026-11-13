import type { DiaryImportState } from '../app/importDiary';

const count = new Intl.NumberFormat('en-US');

function photos(value: number): string {
  return `${count.format(value)} ${value === 1 ? 'photo' : 'photos'}`;
}

function shownText(photoCount: number, unmatchedCount: number): string {
  const shown = `Showing ${photos(photoCount)} from the predictions file.`;
  if (unmatchedCount === 0) return shown;
  const verb = unmatchedCount === 1 ? 'is' : 'are';
  return `${shown} ${count.format(unmatchedCount)} listed ${unmatchedCount === 1 ? 'photo' : 'photos'} ${verb} not in the dropped folder and ${verb} left out.`;
}

export type ImportPredictionsProps = {
  state: DiaryImportState;
  onFile: (file: File) => void;
  /** How to write a predictions file with the official pipeline. */
  helpHref: string;
};

/** Picks a SpeciesNet or MegaDetector predictions file; the diary appears once its folder is dropped. */
export function ImportPredictions({ state, onFile, helpHref }: ImportPredictionsProps) {
  return (
    <section class="import" aria-label="Import predictions">
      <h2>Import predictions</h2>
      <p>
        Bring in the predictions file from SpeciesNet or MegaDetector run on your computer.{' '}
        <a href={helpHref}>How to make one</a>
      </p>
      <label class="file-action">
        Predictions file
        <input
          class="vh"
          type="file"
          accept=".json,application/json"
          disabled={state.status === 'reading'}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            // Clearing lets the same file be chosen again after it is fixed.
            event.currentTarget.value = '';
            if (file) onFile(file);
          }}
        />
      </label>
      {state.status === 'reading' && <p role="status">Reading the predictions file.</p>}
      {state.status === 'waiting' && (
        <p role="status">
          Predictions for {photos(state.photoCount)} read. Drop the folder they were made from to
          see the diary.
        </p>
      )}
      {state.status === 'shown' && (
        <p role="status">{shownText(state.photoCount, state.unmatchedCount)}</p>
      )}
      {state.status === 'failed' && (
        <p role="alert">
          {state.message} <a href={helpHref}>What to do next</a>
        </p>
      )}
    </section>
  );
}
