# Photo worker wiring

The app starts `src/workers/photo.worker.ts` through `src/app/pipeline.ts` using a
module worker URL that Vite rewrites at build time. The worker reports readiness
with its isolation status. It accepts model initialization, then decodes photos,
runs the detector and crop classifier, applies the ensemble and returns labels,
previews and stage timings. Photo requests before initialization fail explicitly.
Resource timing records are forwarded to the page's network meter.

The app selects WASM in `src/main.tsx`. The worker's initial readiness message
names that baseline; the initialization response reports the selected inference
backend. `tests/e2e/worker.spec.ts` checks readiness, isolation, rejection of
requests before initialization and the emitted worker URL under the app base path.
`tests/unit/photo-worker.test.ts` covers initialization, processing and decode
failures; model-backed browser checks live in `tests/e2e/golden.spec.ts` and
`tests/e2e/resume.spec.ts` with their documented fixture prerequisites.

`BASE_URL` controls Vite's base and Playwright's navigation URL, defaulting to `/`.
`PLAYWRIGHT_PORT` selects an available local preview port. Run the worker browser
checks at the root and a deployment subpath with:

```sh
CI=1 PLAYWRIGHT_PORT=19473 npx playwright test worker
CI=1 BASE_URL=/deerdiary/ PLAYWRIGHT_PORT=19473 npx playwright test worker
```

The browser fixture verifies response policies and service worker isolation in
[privacy.md](privacy.md#verification-and-remaining-acceptance). Hosted Pages
behavior still requires a deployment; there is no GitHub remote to verify here.
