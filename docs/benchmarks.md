# Benchmarks

The numbers below come from one machine. They describe how the pipeline behaves there and are not
a promise about another browser, GPU or card. `npm run bench:photos` writes a JSON report; the table
in this file is rendered from the measured report in `docs/benchmarks.json` by `npm run docs:bench`.

## Photo pipeline

```sh
npm run bench:photos -- --files tools/bench/data/card --count 10000
npm run bench:photos -- --wasm
npm run bench:photos -- --files tools/bench/data/card --export .cache/bench/speciesnet.json
```

The runner starts headed Chromium, opens the photo worker with the published detector, classifier,
labels, taxonomy and geofence, and feeds photos through the same processor the app uses. It samples
`ps -A -o pid=,ppid=,rss=` once a second for the whole Chrome tree: the browser wrapper, GPU,
renderer and utility processes.

Options:

| Option                      | Meaning                                                                      |
| --------------------------- | ---------------------------------------------------------------------------- |
| `--files <dir>`             | Card directory. Defaults to `tools/bench/data/card`.                         |
| `--count <n>`               | Fed copies. Defaults to 10,000. Ignored with `--export`.                     |
| `--mode default\|reference` | Manifest role for the detector.                                              |
| `--country <ISO3>`          | Country passed to the ensemble, for example `KEN`.                           |
| `--export <path>`           | Write a SpeciesNet JSON file and feed each card photo once at its real path. |
| `--wasm`                    | Measure WASM only instead of WebGPU and WASM.                                |
| `--results <path>`          | Where to write the JSON report. Defaults to `.cache/bench/results.json`.     |

Every fed copy gets a synthetic path such as `bench/1734/IMAG0042.JPG`, so the app's file key cannot
return a cached result, and the run starts from an empty database. `--export` keeps the card's real
relative paths, feeds each file once and ignores `--count`; the JSON therefore has one prediction per
photo in the card.

### Card resolution

Trail cameras write 8 to 30 MP. If the card's median is under 8 MP, the benchmark does not feed it
directly, because a small photo understates decode cost. Generate the seeded set first:

```sh
uv run --project tools --locked --exact --group reference python tools/bench/upscale.py
```

The tool writes 1,000 4000x3000 Lanczos upscales from the card into `.cache/bench/card-12mp/`, seeded
so the same card produces the same set. The long run uses those files and the report records
`upscaled: true` with the label "upscaled to 12 MP to match decode cost".

### Reported metrics

- Photos per second from the first fed copy to the last.
- Time to first card: the first photo's decode, detection, classification, ensemble and thumbnail.
- Median milliseconds per stage: decode, preprocess, detector, classifier, ensemble, thumbnail, total.
- Peak resident set for the whole Chrome tree, sampled every second.
- RSS slope in bytes per photo, fitted to samples after photo 2,000.
- Machine, Chrome version and ONNX Runtime version.

The WebGPU row uses a headed server because Chrome does not expose WebGPU headless. If WebGPU fails
to initialize, the worker falls back to WASM; `actualBackend` in the JSON records that.

## Measured result

Copy `.cache/bench/results.json` from a full run to `docs/benchmarks.json`, then run `npm run docs:bench`.

<!-- bench:results -->
No measured run is committed yet.
<!-- /bench:results -->

`npm run docs:bench -- --check` validates `docs/benchmarks.json` and fails when this
table no longer matches it. `npm run docs:bench` rewrites the marked block.

## Audio pipeline

`npm run bench:audio -- --files <dir> --count 1000` decodes audio files in Chromium with
`AudioContext.decodeAudioData`, which needs no output device. It reports files per second, seconds of
audio per second, peak Chrome tree RSS and failures, and writes `.cache/bench/audio.json`.

## Cold start

```sh
npm run coldstart -- --url http://localhost:4173 --models-from .cache/models --check
npm run coldstart -- --url http://localhost:4173 --engine webkit --check
```

`npm run coldstart` opens the page in a fresh browser profile, so there is no cache, service worker,
IndexedDB or Cache Storage, and times three steps:

- **T1**: navigation start to the drop zone visible with `crossOriginIsolated === true`. On
  Chromium it waits for the page that the first-visit reload produces, so the reload is inside T1.
- **T2**: the click on "Try the sample" to the first species card, in the same profile.
- **T3**: in a second fresh profile, `setInputFiles` of `tests/e2e/fixtures/photos12/` on the folder
  input to the first species card.

Chromium runs with `Network.emulateNetworkConditions` at 50 Mbit/s down, 10 Mbit/s up and 20 ms
latency. The run also fails if the path from landing to the T3 card shows an
`input[type=password]`, an `input[type=email]` or a settings dialog.

| Option                               | Meaning                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| `--url <url>`                        | Page to open. Defaults to `homepage` in `package.json`; with neither, it stops. |
| `--models-from <dir>`                | Serve every model URL from this folder, matched by file name. See below.        |
| `--engine chromium\|webkit\|firefox` | Browser. Defaults to `chromium`.                                                |
| `--check`                            | Exit non-zero, naming each time over budget.                                    |

The result is printed as JSON and written to `tools/bench/results/coldstart.json`.

### Budgets

T1 is 3 s and T2 is 1 s. T3 is computed from `models/manifest.json`: the bytes of the model files
that a default photo run fetches (detector, classifier, labels, taxonomy and geofence), divided by
50 Mbit/s, plus 10 s. The classifier counted is the fp16 one named by the precision policy. Changing
a model changes the budget without an edit to the script.

### Local models

Route-fulfilled responses skip the network emulation, so with `--models-from` the script answers each
request to Hugging Face from the folder and holds it for its bytes divided by 50 Mbit/s. Responses
queue one after another, because the emulated link is shared. The profile is still clean, and the
T3 gate no longer depends on a shared runner's route to Hugging Face. A request for a file that is
not in the folder fails the run.

Without `--models-from` the models come from Hugging Face. That live T3 is reported and never
gated. It runs only while `tests/e2e/fixtures/photos12/` exists and the manifest marks the exports
published; otherwise the script says why on stderr, records T3 as not measured and still checks T1
and T2. The hosted workflow relies on this until the exports are published.

### Other engines

WebKit and Firefox have no network emulation. `--engine webkit` and `--engine firefox` measure T1 and
T2 unthrottled, end T1 when the drop zone is visible, skip T3, and record `crossOriginIsolated`
and whether the single-thread message was shown.

### Measured result

The block below is rendered from `tools/bench/results/coldstart.json` by `npm run docs:bench`. Commit
that file only from a real run.

<!-- coldstart:results -->
No measured run is committed yet.
<!-- /coldstart:results -->

## What the numbers do not cover

The benchmark measures one browser process on one machine. It does not measure the app shell,
IndexedDB write time outside the pipeline, network transfer, or a second tab competing for the GPU.
Peak RSS includes model load; the slope is the better signal for growth across a long card.
