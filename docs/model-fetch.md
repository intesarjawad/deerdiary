# Model fetch integration

`src/app/models.ts` exports `loadModels(selectedFiles, needs, onProgress?, environment?)`.
It returns `{ persisted, models }`, with an `ArrayBuffer` for each required role.
Keep `persisted` for the storage banner when permission is denied. Progress reports
received and manifest byte counts per role, including an initial zero-byte event.

Pass exactly one manifest entry per required role. This module selects roles from
photo, video and audio presence and the detector mode. It does not choose model
versions or precision. Classifier export and detector selection establish those choices.
Missing or duplicate required roles fail before storage or network access.
Do not pass the unfiltered manifest as a final photo selection.

## Photo models in the app

`defaultPhotoModelFiles()` makes the selection for a default-mode photo drop: the
manifest's `default_detector`, the fp16 classifier export (ADR 0003) and the label,
taxonomy and geofence files exported with it. Sizes and hashes come from the export
entries; the address comes from the `files` entry with the same id. An export without
such an entry throws `ModelUnpublishedError`, so a comparison candidate is never
substituted for it.

`src/app/photoModels.ts` runs the load on the first drop that contains a photo and
keeps the result for the page. Its `state` signal is `idle`, `loading` (with byte
progress once a download starts, published once per megabyte), `ready` or `failed`
with a message that names the cause and the next step. A failed load is not kept, so
dropping the folder again retries. The photo pipeline is created from the resulting
worker start request; a country chosen before that is saved and read when the
pipeline starts.

The exports are pending publication. Until their addresses are in the manifest, a
photo drop ends in the `failed` state and points to [the local pipeline](local-pipeline.md).

`tests/e2e/resume.spec.ts` covers the flow in a browser: it serves the published
addresses from the local export files, processes twelve golden photos, reloads, drops
the folder again and expects no photo request to reach the worker and no model
request to leave the page. It needs the local exports and the golden photos:

```sh
npx playwright test resume
```

Cache Storage uses `deerdiary-models-v1` and the pinned file URL as its key. Cached bytes
are verified again before use. An integrity failure deletes the entry and throws
`ModelIntegrityError` carrying `fileRole`; a subsequent call can download it again.
Quota checks include all missing files before any download and exclude verified
cached files. Unknown quota fails before downloading. Storage, permission, HTTP and
stream errors propagate to the caller.

Verify cache reuse on all three engines:

```sh
npx playwright test tests/e2e/models.spec.ts tests/e2e/models-persistent.spec.ts --project=chromium --project=firefox --project=webkit --project=webkit-persistent
```

The shared suite in `tests/fixtures/model-cache.ts` serves the actual model module with Node's built-in type stripping and
the synthetic manifest from `tests/fixtures/models.ts`. Each local response has
distinct deterministic bytes; the override's sizes and SHA-256 hashes are computed
from those bytes. Production model code and manifest pins are unchanged.

The test injects storage permission denial and sufficient quota through the existing
environment parameter. Firefox persistence permission can otherwise wait for user
input, and browser quota policies are outside this cache test. Fetch, streaming,
SHA-256 and Cache Storage use the real browser implementations. The first load
asserts every expected request and returned byte; after navigation, the second load
asserts identical bytes and no model requests. Named steps also inspect the stored
request URLs before and after reload, distinguishing lost entries from lookup or
integrity failures. Scenarios cover audio alone, photos with audio, and Reference
mode videos with audio, exercising every role without real model weights.

Unit tests retain integrity, quota and persistence-result coverage; manifest tests
retain upstream revision and hash-pin checks. Model loading requires cache reuse, with no
real-weight smoke requirement. Inference smoke coverage remains separate.

## WebKit reload investigation

Browser evidence: Chromium and Firefox reuse the two synthetic audio entries;
WebKit requests both again after reload. The original fixture contained only
`perch` and `perch_labels`, and the test selected audio alone. Those requests were
the entire selected set, not evidence that photo entries persisted.

Every role follows the same storage path in `loadModels`:

- Cache Storage in `deerdiary-models-v1`; there is no OPFS implementation or audio branch.
- `file.url` is passed unchanged to `match`, `put`, and `delete`. Both synthetic
  URLs and pinned upstream URLs are absolute. There is no role-specific URL
  normalization, request method, or key prefix.
- Downloads are streamed and verified, then stored as `new Response(bytes)`.
  Upstream content types and other response headers are discarded for all roles.
  Constructing a response from an ArrayBuffer does not supply a content type.
  Cached bytes are verified again before use.

The explanation is the lifetime of Cache Storage entries in WebKit's
ephemeral context, rather than audio handling. The test uses the default isolated
Playwright context. An [upstream report with the same reload symptom](https://github.com/microsoft/playwright/issues/41618)
records that ephemeral WebKit contexts lose Cache Storage entries on reload,
while persistent contexts have different behavior. The comparison
confirmed the difference in this harness.

## Persistent WebKit comparison

The `webkit-persistent` project runs `tests/e2e/models-persistent.spec.ts` using
`tests/fixtures/persistent-webkit.ts`. The fixture overrides `context` with
`playwright.webkit.launchPersistentContext` and a fresh temporary profile for each
scenario. It closes the context before removing the profile, including on test
failure. Playwright inherits the configured context options, including `baseURL`.
Both entry points register the same scenarios and assertions from
`tests/fixtures/model-cache.ts`; only the context lifetime differs.

The existing Chromium, Firefox and WebKit projects retain ephemeral contexts.
The persistent project is opt-in and matches only the persistent cache spec;
existing projects exclude that spec. Run the comparison in a normal desktop session:

```sh
npx playwright test tests/e2e/models.spec.ts --project=webkit
npx playwright test tests/e2e/models-persistent.spec.ts --project=webkit-persistent
```

On 2026-11-05, the results showed that ephemeral WebKit failed the cache
test, persistent WebKit passed all three scenarios, and Chromium and Firefox
passed. The verdict is a harness artifact consistent with
[Playwright issue #41618](https://github.com/microsoft/playwright/issues/41618);
production Cache Storage is correct. The ephemeral WebKit cache tests are
expected to fail, and persistent WebKit verifies cache reuse.
