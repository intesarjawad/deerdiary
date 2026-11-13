/// <reference types="vite/client" />
import { signal } from '@preact/signals';
import { render } from 'preact';
import { useEffect, useMemo } from 'preact/hooks';
import { unsupportedClipsNote } from './app/clips';
import { correctionLabels, loadCorrectionVocabulary } from './app/correctionLabels';
import { diaryExports, type ExportFile } from './app/export';
import { COUNTRY_FIXED_NOTE, importErrorMessage, matchPhotoPath } from './app/import';
import { createDiaryImporter } from './app/importDiary';
import { DEFAULT_DETECTOR_ID, defaultPhotoModelBytes } from './app/models';
import { createNetworkMeter, type NetworkSnapshot, observeResources } from './app/networkMeter';
import { createPhotoModelLoader, modelDownloadText } from './app/photoModels';
import { createPhotoWorker, PhotoPipeline } from './app/pipeline';
import { createReelExporter } from './app/reelExport';
import { createSampleLoader, sampleOriginalURL } from './app/sample';
import { enableOfflineApp } from './app/serviceWorker';
import { createPipelineState } from './app/state';
import { createThumbnailURLs, thumbnailBlobs } from './app/thumbnails';
import { type CamtrapDraft, type CamtrapMetadata, emptyCamtrapDraft } from './core/camtrapMetadata';
import { hourBins } from './core/clock';
import { correctedEvents } from './core/corrections';
import { cameraKey } from './core/events';
import { exclusiveCorrectionKeys, firstSightings, sessionSummaries } from './core/history';
import { DEFAULT_INDEPENDENCE_INTERVAL_MIN, independentDetections } from './core/independence';
import { isCameraTime, wallClockDateRange } from './core/time';
import type { ScannedFile } from './files/scan';
import { PhotoStorage } from './storage/db';
import type { Session, StoredResult } from './storage/schema';
import { CamtrapExport } from './ui/CamtrapExport';
import { Clock } from './ui/Clock';
import { type CorrectionStorage, Corrections } from './ui/Corrections';
import { CountrySelect, countryForTimeZone } from './ui/CountrySelect';
import { Diary } from './ui/Diary';
import { DropZone } from './ui/DropZone';
import { exportSession, History, restoreSession } from './ui/History';
import { ImportPredictions } from './ui/ImportPredictions';
import { Joiner } from './ui/Joiner';
import { Progress } from './ui/Progress';
import { Reel } from './ui/Reel';
import './ui/styles/base.css';

const STOPPED_HREF = 'https://github.com/intesarjawad/deerdiary/blob/main/docs/local-pipeline.md';
const MEGABYTE = 1_000_000;

const root = document.getElementById('app');
if (root === null) {
  throw new Error('Missing #app root in index.html.');
}

const state = createPipelineState();
const country = signal<string | undefined>(undefined);
const vocabulary = signal<readonly string[]>([]);
const corrections = signal<Readonly<Record<string, string>>>({});
const correctionStorage = signal<CorrectionStorage | undefined>(undefined);
const startError = signal<string | null>(null);
const historyData = signal<{ sessions: Session[]; results: StoredResult[] }>({
  sessions: [],
  results: [],
});
const historyMessage = signal<string | null>(null);
const currentSessionId = signal<string | undefined>(undefined);
const processing = signal(false);
let pipelineSessionId: string | undefined;
let attachingOriginals = false;
const camtrapForm = signal<{ sessionId: string; draft: CamtrapDraft } | null>(null);
const camtrapMessage = signal<string | null>(null);
const camtrapMemoryOnly = signal(false);
const thumbnails = createThumbnailURLs();
const appBaseUrl = new URL(import.meta.env.BASE_URL, location.href).href;
const photoModels = createPhotoModelLoader({ baseUrl: appBaseUrl, backend: 'wasm' });

const meter = createNetworkMeter();
const network = signal<NetworkSnapshot>(meter.snapshot());
observeResources((resources) => {
  meter.record(resources);
  network.value = meter.snapshot();
});
let vocabularyLoading: Promise<void> | undefined;
state.results.subscribe((results) => {
  thumbnails.update(results);
  if (results.length > 0) {
    if (vocabularyLoading !== undefined) return;
    vocabularyLoading = loadCorrectionVocabulary()
      .then((labels) => {
        vocabulary.value = labels;
      })
      .catch((cause: unknown) => {
        vocabularyLoading = undefined;
        startError.value = reason(cause);
      });
  }
});

let pipeline: PhotoPipeline | undefined;
let storage: PhotoStorage | undefined;
let warmWorker: Worker | undefined;
let countryChosen = false;
let droppedFolder: readonly ScannedFile[] = [];
let droppedFiles: ReadonlyMap<string, ScannedFile['source']> = new Map();

/** True only while the diary on screen came from "Try the sample"; a folder's name never sets it. */
let bundledSample = false;
/** Carries a "Try the sample" press across the first visit's isolating reload, which would drop it. */
const SAMPLE_PRESSED_KEY = 'deerdiary-sample-pressed';
let samplePressed = false;
const originals = new Map<string, string>();
const originalsLoaded = signal(0);

function releaseOriginals() {
  for (const url of originals.values()) URL.revokeObjectURL(url);
  originals.clear();
}

/** A URL for the original frame while this page still holds it, for the large portraits. */
function originalURL(path: string): string | undefined {
  originalsLoaded.value;
  const known = originals.get(path);
  if (known) return known;
  const source = droppedFiles.get(path);
  if (source) {
    const make = (file: Blob) => {
      originals.set(path, URL.createObjectURL(file));
      originalsLoaded.value += 1;
    };
    if ('getFile' in source) void source.getFile().then(make);
    else make(source);
    return undefined;
  }
  return sampleOriginalURL(path, bundledSample, appBaseUrl);
}

/** The original from this page's drop; a session restored after a reload keeps only its preview. */
async function loadReelPhoto(path: string): Promise<Blob> {
  const source = droppedFiles.get(path);
  if (source) return 'getFile' in source ? source.getFile() : source;
  const sampleURL = sampleOriginalURL(path, bundledSample, appBaseUrl);
  if (sampleURL) {
    const response = await fetch(sampleURL);
    if (!response.ok) throw new Error(`Could not load ${path}: ${response.status}.`);
    return response.blob();
  }
  const preview = thumbnailBlobs(state.results.value).get(path);
  if (preview) return preview;
  throw new Error(`${path} is no longer available. Drop its folder again.`);
}

const reelExporter = createReelExporter({
  loadPhoto: loadReelPhoto,
  save: ({ name, blob }) => saveBlob(name, blob),
});

/** Shows a diary that was computed elsewhere: an imported predictions file or the sample. */
function showDiary(results: readonly StoredResult[], saved: Readonly<Record<string, string>>) {
  pipelineSessionId = undefined;
  attachingOriginals = false;
  bundledSample = false;
  camtrapForm.value = null;
  camtrapMessage.value = null;
  corrections.value = { ...corrections.value, ...saved };
  currentSessionId.value = undefined;
  state.failure.value = null;
  state.publish(
    results,
    {
      ...state.progress.value,
      done: results.length,
      total: results.length,
      photosPerSecond: 0,
      secondsLeft: null,
    },
    false,
  );
}

const diaryImport = createDiaryImporter({
  show: (results, saved) => {
    sample.reset();
    showDiary(results, saved);
  },
  ensembleContext: async () => (await photoModels.init())?.context,
});

const sample = createSampleLoader({
  baseUrl: appBaseUrl,
  show: (results, saved) => {
    diaryImport.reset();
    releaseOriginals();
    droppedFiles = new Map();
    droppedFolder = [];
    showDiary(results, saved);
    bundledSample = true;
  },
});

function createWorker(): Worker {
  const worker = warmWorker ?? createPhotoWorker(meter);
  warmWorker = undefined;
  return worker;
}

function reason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function refreshHistory() {
  if (storage === undefined) return;
  const sessions = await storage.listSessions();
  const results = await storage.loadResults(sessions.flatMap(({ fileKeys }) => fileKeys));
  historyData.value = { sessions, results };
}

function download(file: ExportFile) {
  saveBlob(file.name, new Blob([file.text], { type: file.type }));
}

function saveBlob(name: string, blob: Blob) {
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = name;
  link.click();
  link.remove();
  // The browser must start the download before this document releases the blob.
  setTimeout(() => URL.revokeObjectURL(href), 0);
}

function App() {
  const rawEvents = state.events.value;
  const events = useMemo(
    () => correctedEvents(rawEvents, corrections.value),
    [rawEvents, corrections.value],
  );
  const results = state.results.value;
  const progress = state.progress.value;
  const failure = state.failure.value;
  const storageNote = state.storageNote.value;
  const modelLoad = photoModels.state.value;
  const importState = diaryImport.state.value;
  const sampleState = sample.state.value;
  const hasResults = results.length > 0;
  useEffect(() => {
    if (modelLoad.status === 'loading')
      document.querySelector('.model-load')?.scrollIntoView({ block: 'nearest' });
  }, [modelLoad.status]);
  const intakeDisabled = processing.value || sampleState.status === 'loading';
  const cameras = useMemo(
    () =>
      [
        ...new Set(
          results
            .filter(({ output }) => output.status === 'ok')
            .map(({ output }) => cameraKey(output.path)),
        ),
      ].sort(),
    [results],
  );
  const clipsNote = useMemo(() => unsupportedClipsNote(results), [results]);

  const bins = useMemo(
    () =>
      hourBins(
        independentDetections(events, DEFAULT_INDEPENDENCE_INTERVAL_MIN)
          .filter((detection) => detection.time.clockStatus === 'ok')
          .map((detection) => detection.time.wallClockMs),
      ),
    [events],
  );
  const summaries = useMemo(
    () =>
      sessionSummaries(historyData.value.sessions, historyData.value.results, corrections.value),
    [historyData.value, corrections.value],
  );
  const newSpecies = useMemo(() => {
    const current = summaries.find(({ id }) => id === currentSessionId.value);
    return current && firstSightings(summaries, current).map(({ label }) => label);
  }, [summaries, currentSessionId.value]);
  const labels = useMemo(
    () => correctionLabels(rawEvents, corrections.value, vocabulary.value),
    [rawEvents, corrections.value, vocabulary.value],
  );

  async function processDrop(files: ScannedFile[]) {
    if (processing.value || sample.state.value.status === 'loading') return;
    if (attachingOriginals) {
      const paths = files.filter(({ kind }) => kind === 'photo').map(({ path }) => path);
      const attached = new Map<string, ScannedFile['source']>();
      for (const { output } of state.results.value) {
        const match = matchPhotoPath(output.path, paths);
        const file = files.find(({ path }) => path === match);
        if (file) attached.set(output.path, file.source);
      }
      releaseOriginals();
      droppedFiles = attached;
      attachingOriginals = false;
      originalsLoaded.value += 1;
      historyMessage.value =
        attached.size === 0
          ? 'No originals matched. Choose the folder this diary came from.'
          : 'Originals attached to this diary. Saved labels and corrections are kept.';
      return;
    }
    processing.value = true;
    try {
      camtrapForm.value = null;
      camtrapMessage.value = null;
      bundledSample = false;
      const startedAt = Date.now();
      droppedFolder = files;
      if (diaryImport.needsFolder() || diaryImport.state.value.status === 'reading') {
        releaseOriginals();
        droppedFiles = new Map(files.map((file) => [file.path, file.source]));
        await diaryImport.attach(files, startedAt);
        return;
      }
      // The drop summary already reports a folder without photos or videos; it must not start a download.
      if (!files.some(({ kind }) => kind === 'photo' || kind === 'video')) return;
      meter.start();
      if (storage === undefined) {
        state.failure.value = {
          message: 'The photo pipeline is still starting. Try the folder again in a moment.',
          href: STOPPED_HREF,
        };
        return;
      }
      // A clip has no still original, so the reel falls back to its stored frame preview.
      releaseOriginals();
      droppedFiles = new Map(
        files.filter(({ kind }) => kind === 'photo').map((file) => [file.path, file.source]),
      );
      const init = await photoModels.init();
      if (init === undefined) return;
      diaryImport.reset();
      sample.reset();
      pipeline ??= new PhotoPipeline({ storage, state, createWorker, init });
      try {
        const id = crypto.randomUUID();
        currentSessionId.value = id;
        pipelineSessionId = id;
        await pipeline.run(files, { id, createdAtMs: startedAt }, startedAt);
      } catch (cause) {
        state.failure.value = {
          message: `Could not process this folder. ${reason(cause)}`,
          href: STOPPED_HREF,
        };
      }
      await refreshHistory().catch((cause: unknown) => {
        historyMessage.value = `Could not read the saved sessions. ${reason(cause)}`;
      });
    } finally {
      processing.value = false;
    }
  }

  async function changeHistory(action: () => Promise<string>) {
    try {
      historyMessage.value = await action();
      await refreshHistory();
    } catch (cause) {
      historyMessage.value = `That did not work. ${reason(cause)}`;
    }
  }

  function openHistorySession(id: string) {
    if (intakeDisabled) return;
    const { sessions, results } = historyData.value;
    const session = sessions.find((entry) => entry.id === id);
    if (session === undefined) return;
    sample.reset();
    diaryImport.reset();
    releaseOriginals();
    droppedFiles = new Map();
    droppedFolder = [];
    const own = results.filter(({ key }) => session.fileKeys.includes(key));
    const usable = own.filter(({ time }) => isCameraTime(time));
    showDiary(usable, corrections.value);
    if (usable.length !== own.length) {
      state.failure.value = {
        message:
          'Some saved photos have invalid camera times. Export the session for recovery or delete it.',
        href: STOPPED_HREF,
      };
    }
    currentSessionId.value = id;
    historyMessage.value = 'Session opened. Reattach its folder for original photos.';
  }

  function exportHistorySession(id: string) {
    const { sessions, results } = historyData.value;
    const session = sessions.find((entry) => entry.id === id);
    if (session) download(exportSession(session, results, corrections.value));
  }

  function deleteHistorySession(id: string) {
    void changeHistory(async () => {
      const { sessions, results } = historyData.value;
      const session = sessions.find((entry) => entry.id === id);
      if (storage === undefined || session === undefined) return 'That session is already gone.';
      const keys = exclusiveCorrectionKeys(
        session,
        sessions.filter((entry) => entry.id !== id),
        results,
        corrections.value,
      );
      await storage.deleteSession(id, keys);
      corrections.value = Object.fromEntries(
        Object.entries(corrections.value).filter(([key]) => !keys.includes(key)),
      );
      if (currentSessionId.value === id) {
        currentSessionId.value = undefined;
        state.publish([], { ...state.progress.value, done: 0, total: 0 }, false);
      }
      return 'Session deleted.';
    });
  }

  function importHistorySession(file: File) {
    void changeHistory(async () => {
      const restored = restoreSession(await file.text());
      if (!restored.ok) return importErrorMessage(restored.field);
      if (storage === undefined) return 'Saved sessions are not ready yet. Try again in a moment.';
      const { session, results, corrections: saved } = restored.value;
      await storage.restoreSession(session, results, saved);
      corrections.value = { ...corrections.value, ...saved };
      return 'Session imported.';
    });
  }

  function chooseCountry(next: string | undefined) {
    country.value = next;
    countryChosen = true;
    const location = next === undefined ? {} : { country: next };
    const importShown = diaryImport.state.value.status === 'shown';
    if (importShown) void diaryImport.setCountry(next);
    const saving =
      (pipelineSessionId !== undefined && pipelineSessionId === currentSessionId.value
        ? pipeline?.setLocation(location)
        : undefined) ?? storage?.saveLocation(location);
    void saving?.catch((cause: unknown) => {
      state.failure.value = {
        message: `Could not save the country. ${reason(cause)}`,
        href: STOPPED_HREF,
      };
    });
  }

  async function runSample() {
    if (intakeDisabled) return;
    const files = await sample.photos();
    if (files !== undefined) await processDrop(files);
  }

  async function openCamtrap() {
    camtrapMessage.value = null;
    try {
      if (storage === undefined)
        throw new Error('Saved sessions are not ready yet. Try again in a moment.');
      await refreshHistory();
      let session = historyData.value.sessions.find(({ id }) => id === currentSessionId.value);
      if (session === undefined) {
        session = {
          id: crypto.randomUUID(),
          createdAtMs: Date.now(),
          fileKeys: state.results.value.map(({ key }) => key),
          dateRange: wallClockDateRange(state.results.value.map(({ time }) => time)),
        };
        await storage.restoreSession(session, state.results.value, corrections.value);
        currentSessionId.value = session.id;
        await refreshHistory();
      }
      camtrapMemoryOnly.value = storage.memoryOnly;
      camtrapForm.value = {
        sessionId: session.id,
        draft: session.camtrap ?? emptyCamtrapDraft(cameras),
      };
    } catch (cause) {
      camtrapMessage.value = `Could not open export details. ${reason(cause)}`;
    }
  }

  function currentExports(camtrap?: CamtrapMetadata) {
    return diaryExports(
      {
        results: state.results.value,
        events: state.events.value,
        ...(camtrap === undefined ? {} : { camtrap }),
        corrections: corrections.value,
        // A diary shown from a file does not record which detector made it.
        detector: currentSessionId.value === undefined ? 'unknown' : DEFAULT_DETECTOR_ID,
      },
      new Date().toISOString(),
    );
  }

  const photoURL = (path: string) => thumbnails.url(path) ?? originalURL(path);
  const fullPhotoURL = (path: string) => originalURL(path) ?? photoURL(path);
  const countrySelect = (
    <CountrySelect
      value={country.value}
      onChange={chooseCountry}
      note={
        importState.status === 'shown' && importState.countryFixed
          ? COUNTRY_FIXED_NOTE
          : hasResults && pipelineSessionId === undefined
            ? 'Shown labels are kept. Country applies to the next folder you process.'
            : undefined
      }
    />
  );

  function addFolder() {
    attachingOriginals = hasResults && pipelineSessionId === undefined && !bundledSample;
    document.querySelector<HTMLButtonElement>('.dropzone .actions .primary')?.click();
  }

  const importSection = (
    <ImportPredictions
      state={importState}
      helpHref={STOPPED_HREF}
      onFile={async (file) => {
        if (intakeDisabled) return;
        const startedAt = Date.now();
        await diaryImport.read(file, droppedFolder, startedAt);
        if (diaryImport.state.value.status === 'waiting' && droppedFolder.length > 0)
          await diaryImport.attach(droppedFolder, startedAt);
      }}
    />
  );

  return (
    <main aria-label="Deerdiary" data-results={hasResults}>
      <header class="masthead" data-hero={!hasResults}>
        <div class="title">
          {/* Before a diary the joiner's claim is the page's heading, and the name is a wordmark. */}
          {hasResults ? <h1>Deerdiary</h1> : <p class="wordmark">Deerdiary</p>}
          <p class="lede">
            Drop a trail-camera card folder to get a species diary. Photos stay in this browser.
          </p>
        </div>
        <div class="intake">
          <DropZone disabled={intakeDisabled} onScan={processDrop}>
            <button
              type="button"
              class="try-sample"
              disabled={intakeDisabled}
              onClick={() => {
                if (intakeDisabled) return;
                samplePressed = true;
                void sample.load();
              }}
            >
              Try the sample
            </button>
            <span class="sample-note">Caltech Camera Traps photos. No model download.</span>
          </DropZone>
          {sampleState.status === 'failed' && <p role="alert">{sampleState.message}</p>}
          {modelLoad.status === 'failed' && (
            <p role="alert">
              {modelLoad.message} <a href={STOPPED_HREF}>What to do next</a>
            </p>
          )}
          {startError.value !== null && (
            <p role="alert">Could not start Deerdiary. {startError.value}</p>
          )}
          {failure !== null && (
            <p role="alert">
              {failure.message} <a href={failure.href}>What to do next</a>
            </p>
          )}
          {sampleState.status === 'shown' && (
            <p class="notice" role="status">
              Computed ahead of time by this app. These model predictions include mistakes; review
              the photos.{' '}
              <button
                type="button"
                disabled={intakeDisabled}
                onClick={() => {
                  void runSample();
                }}
              >
                Run it in this tab
              </button>{' '}
              (downloads {Math.round(defaultPhotoModelBytes() / MEGABYTE)} MB once)
            </p>
          )}
          {modelLoad.status === 'loading' && (
            <div class="model-load">
              <p role="status">Loading the photo models.</p>
              {modelLoad.progress !== null && (
                <p>
                  <label>
                    {modelDownloadText(modelLoad.progress)}{' '}
                    <progress
                      max={modelLoad.progress.totalBytes}
                      value={modelLoad.progress.receivedBytes}
                    />
                  </label>
                </p>
              )}
            </div>
          )}
          <Progress progress={progress}>{hasResults && countrySelect}</Progress>
        </div>
        {!hasResults && <Joiner base={appBaseUrl} />}
        {/* Before a diary the country sits under the sheet, not between the gate and the sheet. */}
        {!hasResults && <div class="country">{countrySelect}</div>}
      </header>
      {storageNote !== null && (
        <p class="notice" role="status">
          {storageNote}
        </p>
      )}
      {clipsNote !== null && (
        <p class="notice" role="status">
          {clipsNote}
        </p>
      )}
      {hasResults && (
        <>
          <Diary
            events={events}
            firstSightings={newSpecies}
            thumbnailURL={photoURL}
            photoURL={fullPhotoURL}
            originalURL={originalURL}
            originalsMissing={droppedFiles.size === 0 && !bundledSample}
            onAddFolder={addFolder}
            photoCount={results.filter(({ output }) => output.status === 'ok').length}
            network={network.value}
          />
          <Clock bins={bins} />
          <Reel
            events={events}
            photoURL={fullPhotoURL}
            exporter={reelExporter}
            photoAvailable={(path) =>
              droppedFiles.has(path) ||
              sampleOriginalURL(path, bundledSample, appBaseUrl) !== undefined ||
              thumbnailBlobs(results).has(path)
            }
            onAttachOriginals={addFolder}
          />
          <Corrections
            events={rawEvents}
            labels={labels}
            corrections={corrections.value}
            onChange={(key, value) => {
              corrections.value =
                value === null
                  ? Object.fromEntries(
                      Object.entries(corrections.value).filter(([entry]) => entry !== key),
                    )
                  : { ...corrections.value, [key]: value };
            }}
            storage={correctionStorage.value}
            country={country.value}
            imageURL={(path) => originalURL(path) ?? photoURL(path)}
          />
          <section aria-label="Exports">
            <h2>Download</h2>
            <p class="actions">
              <button type="button" onClick={() => download(currentExports().csv)}>
                Download CSV
              </button>{' '}
              <button type="button" onClick={() => download(currentExports().json)}>
                Download SpeciesNet JSON
              </button>{' '}
              <button type="button" onClick={() => download(currentExports().megadetector)}>
                Download MegaDetector JSON
              </button>{' '}
              <button
                type="button"
                data-camtrap-open
                disabled={cameras.length === 0 || progress.done < progress.total}
                aria-expanded={camtrapForm.value !== null}
                onClick={() => {
                  void openCamtrap();
                }}
              >
                Download Camtrap DP
              </button>
            </p>
            {camtrapMessage.value && <p role="alert">{camtrapMessage.value}</p>}
            {camtrapForm.value && (
              <CamtrapExport
                key={camtrapForm.value.sessionId}
                cameras={cameras}
                initial={camtrapForm.value.draft}
                memoryOnly={camtrapMemoryOnly.value}
                onSave={async (draft) => {
                  const id = camtrapForm.value?.sessionId;
                  if (storage === undefined || id === undefined)
                    throw new Error('Reopen the export details to save them.');
                  await storage.saveCamtrapDraft(id, draft);
                  camtrapMemoryOnly.value = storage.memoryOnly;
                }}
                onDownload={(metadata) => {
                  for (const file of currentExports(metadata).camtrapDp) download(file);
                  void refreshHistory().catch((cause: unknown) => {
                    historyMessage.value = reason(cause);
                  });
                }}
                onClose={() => {
                  camtrapForm.value = null;
                  document.querySelector<HTMLButtonElement>('[data-camtrap-open]')?.focus();
                }}
              />
            )}
            <p>
              Camtrap DP downloads four files that belong in one folder: the datapackage and its
              three tables.
            </p>
          </section>
        </>
      )}
      <fieldset class="aftercare" disabled={intakeDisabled}>
        {importSection}
        <History
          summaries={summaries}
          onOpen={openHistorySession}
          onExport={exportHistorySession}
          onDelete={deleteHistorySession}
          onImport={importHistorySession}
          message={historyMessage.value}
        />
      </fieldset>
    </main>
  );
}

render(<App />, root);

function pressedBeforeReload(): boolean {
  try {
    const pressed = sessionStorage.getItem(SAMPLE_PRESSED_KEY) === '1';
    sessionStorage.removeItem(SAMPLE_PRESSED_KEY);
    return pressed;
  } catch {
    return false;
  }
}

async function start() {
  if (
    import.meta.env.PROD &&
    !(await enableOfflineApp(new URL(import.meta.env.BASE_URL, location.href).href))
  ) {
    addEventListener('pagehide', () => {
      if (!samplePressed) return;
      try {
        sessionStorage.setItem(SAMPLE_PRESSED_KEY, '1');
      } catch {}
    });
    return;
  }

  storage = await PhotoStorage.open();
  const saved = await storage.loadLocation();
  corrections.value = await storage.loadCorrections();
  correctionStorage.value = storage;
  if (pressedBeforeReload()) void sample.load();
  await refreshHistory();
  if (!countryChosen) country.value = saved?.country;

  // One worker is started with the shell so its module and isolation checks run before a drop.
  warmWorker = createPhotoWorker(meter);

  const initialCountry = countryChosen
    ? country.value
    : saved === undefined
      ? countryForTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone)
      : saved.country;
  if (countryChosen || initialCountry !== undefined) {
    await storage.saveLocation(initialCountry === undefined ? {} : { country: initialCountry });
  }
}

void start().catch((error: unknown) => {
  startError.value = reason(error);
});
