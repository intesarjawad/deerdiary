# Development notes

You need Node 26 with npm 11, and Python 3.12 with uv for the model tools.

## Checks

```sh
npm install
npm run check && npm run build && npm run size
```

`npm install` runs `prepare`, which points Git at the hooks in `.githooks`.
`npm run size` sums the gzip size of every `dist/assets/*.js` file and fails at
250,000 bytes or more. The ONNX Runtime files under `dist/ort/` are counted
separately. The build copies the asyncify ONNX Runtime `.wasm` and `.mjs` files into `public/ort/`.

## Python environments

The model tools live in `tools/pyproject.toml` on Python 3.12, in two dependency
groups that share `tools/.venv`. Run them one after the other, never with
`--all-groups`:

```sh
cd tools
uv sync --locked --exact --group reference
uv run --locked --exact --group reference python <script>
uv sync --locked --exact --group onnx
uv run --locked --exact --group onnx python <script>
```

The [dependency ADR](adr/python-dependencies.md) explains why the groups are
split and why the megadetector package is not installed.

## Browser tests

`npm run e2e` runs Playwright against the built app in Chromium, Firefox and
WebKit. The `chromium-headful` project is selected by name and is the only one
that can use WebGPU.

## Runtime smoke harness

On a machine with headed Chromium and the model cache:

```sh
npx playwright test smoke --project=chromium-headful --workers=1 --reporter=line
```

Set `HF_HUB_CACHE` if the model snapshots are somewhere else. The harness checks
every model's size and SHA-256 against the manifest, then serves the cached
files over CORS. It never downloads a missing model.

The command builds the harness and its worker into a fresh temporary directory,
copies the runtime files beside them, and only then starts a static preview
server on a free loopback port. Nothing watches the repository, so a file write
cannot reload the page in the middle of a measurement. The directory is removed
when the harness closes.

Each model runs five zero-tensor inferences with WebGPU and five with WASM
alone, in separate workers. The output is one JSON row per run: model, requested
backend, output shapes, median milliseconds, cross-origin isolation and any
error. A worker reports import and inference failures with their stack and
nested causes.

To inspect the response headers by hand, start the same server with
`node tools/bench/server.ts` and request the printed URL. Every response must
carry `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`.

## Try it with your own photos before release

The photo models are not published yet, so a production build refuses to label
photos. `npm run dev` instead serves each export from its `local_path` in
`models/manifest.json` and checks the same size and SHA-256 as a published
download. The dev server alone does this: `npm run build` and `npm run preview`
still report the models as unpublished.

1. Build the exports once. They land in `.cache/exports/`, which Git ignores.
   The two prepare steps need the `reference` group, the checks the `onnx`
   group, as described in [the detector export](detector-export.md) and
   [the classifier export](classifier-export.md):

   ```sh
   cd tools
   uv sync --locked --exact --group reference
   uv run --locked --exact --group reference python export/rtdetr_apache.py --prepare-reference
   uv run --locked --exact --group reference python export/speciesnet_crop.py --prepare-reference
   uv sync --locked --exact --group onnx
   uv run --locked --exact --group onnx python export/rtdetr_apache.py --check
   uv run --locked --exact --group onnx python export/speciesnet_crop.py --check
   cd ..
   ```

2. Copy the ONNX Runtime files into `public/ort/` and start the app, then drop
   a folder of photos on the page:

   ```sh
   npm run prebuild
   npm run dev
   ```

The first drop reads about 200 MB from disk and verifies it; photos never leave
the browser.

## Instant sample

`public/sample/` holds 60 photos from one Caltech Camera Traps location; its
`PROVENANCE.txt` names the source, licence, ranking and every file. To rebuild
the photos and check them:

```sh
cd tools
uv run --locked --exact --group onnx python -m sample.make_demo_card
uv run --locked --exact --group onnx python sample/make_sample.py --check ../public/sample
```

The builder fails if the dataset page no longer states its licence. Look at
every photo before committing: the dataset labels at least one frame showing a
person as empty. `npm run sample:predict` then drops the photos on the built app
in headless Chromium and writes `predictions.json` and `thumbs/`. Rerun it
whenever a model in the manifest changes. `npm run sample:thumbs` rewrites only `thumbs/`, without
any model, as whole-frame previews at the size the app stores.

## Not built yet

Some npm commands print `PENDING`, name the missing feature and exit 1. They
never report a measurement or download a model.

Publication is pending. Hosted CI, Pages, branch protection, private security
reporting and package publishing are set up when the repository is public.
