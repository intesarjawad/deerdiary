import { signal } from '@preact/signals';
import { type ScannedFile, scannedFile } from '../files/scan';
import type { StoredResult } from '../storage/schema';
import { restoreSession } from '../ui/History';

/**
 * The instant sample is the app's own session export of a run over `public/sample/`, written by
 * `npm run sample:predict`, plus the 160 px previews that run stored, one per photo under
 * `thumbs/` with the photo's file name. Photo paths in the export start with `sample/`, so each
 * resolves against the app base to the photo itself.
 */
const SAMPLE_PREDICTIONS = 'sample/predictions.json';
const SAMPLE_THUMBNAILS = 'sample/thumbs/';
const NOT_FOUND = 404;

export type SampleState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'shown'; photoPaths: readonly string[] }
  | { status: 'failed'; message: string };

type SampleLoaderOptions = {
  baseUrl: string;
  /** Replaces the diary on screen with the precomputed one. */
  show: (results: readonly StoredResult[], corrections: Readonly<Record<string, string>>) => void;
  fetch?: typeof fetch;
};

class SampleFetchError extends Error {
  constructor(readonly status: number) {
    super(`The server answered ${status}.`);
  }
}

/**
 * Where a frame of the bundled sample can be fetched in full, or undefined. Only the explicit
 * "sample shown" state grants it: a path alone proves nothing, because a user's own folder can be
 * named `sample` too.
 */
export function sampleOriginalURL(path: string, bundledSampleShown: boolean, baseUrl: string) {
  return bundledSampleShown && path.startsWith('sample/') ? new URL(path, baseUrl).href : undefined;
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function failureMessage(error: unknown): string {
  if (error instanceof SampleFetchError && error.status === NOT_FOUND) {
    return 'This copy of the app was built without the sample. Drop your own card folder instead.';
  }
  // fetch rejects with a TypeError only when no response arrived.
  if (error instanceof TypeError) {
    return 'Could not download the sample. Check the internet connection, then press "Try the sample" again.';
  }
  const reason = error instanceof Error ? error.message : String(error);
  return `Could not load the sample. ${reason} Reload the page, then press "Try the sample" again.`;
}

/** Shows the precomputed sample diary without the models, and fetches its photos for a live run. */
export function createSampleLoader({ baseUrl, show, fetch: get = fetch }: SampleLoaderOptions) {
  const state = signal<SampleState>({ status: 'idle' });

  async function download(path: string): Promise<Blob> {
    const response = await get(new URL(path, baseUrl));
    if (!response.ok) throw new SampleFetchError(response.status);
    return response.blob();
  }

  return {
    state,
    async load(): Promise<void> {
      state.value = { status: 'loading' };
      try {
        const restored = restoreSession(await (await download(SAMPLE_PREDICTIONS)).text());
        if (!restored.ok) throw new Error(`The sample file has a bad "${restored.field}" field.`);
        const results = await Promise.all(
          restored.value.results.map(async (result) =>
            result.output.status === 'ok'
              ? {
                  ...result,
                  output: {
                    ...result.output,
                    thumbnail: await download(SAMPLE_THUMBNAILS + fileName(result.output.path)),
                  },
                }
              : result,
          ),
        );
        show(results, restored.value.corrections);
        state.value = { status: 'shown', photoPaths: results.map(({ output }) => output.path) };
      } catch (error) {
        state.value = { status: 'failed', message: failureMessage(error) };
      }
    },
    /** Resolves to the sample photos as a dropped folder, or undefined once `state` holds why not. */
    async photos(): Promise<ScannedFile[] | undefined> {
      const shown = state.value;
      if (shown.status !== 'shown') return undefined;
      try {
        const files = await Promise.all(
          shown.photoPaths.map(async (path) => {
            const file = new File([await download(path)], fileName(path), {
              type: 'image/jpeg',
              // The photos carry their capture time in EXIF; a fixed file time keeps resume keys stable.
              lastModified: 0,
            });
            return scannedFile(file, path, file);
          }),
        );
        state.value = { status: 'idle' };
        return files;
      } catch (error) {
        state.value = { status: 'failed', message: failureMessage(error) };
        return undefined;
      }
    },
    /** Hides the banner once another diary replaces the sample. */
    reset() {
      state.value = { status: 'idle' };
    },
  };
}
