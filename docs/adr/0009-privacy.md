# ADR 0009: Privacy policy, runtime caching and isolation

Status: implemented with automated browser checks; hosted verification pending.

## Context

The static host cannot set response headers. A CSP meta tag protects the initial
page but does not provide the policy for dedicated worker scripts, where file
processing runs. The app also needs cached shell files and model bytes to
work without a network connection.

## Privacy enforcement decision

Keep CSP, COOP and COEP in `bin/headers.mjs` for the service worker and local
server. Copy CSP into the initial HTML meta tag and test equality. Emit a
self-contained classic service worker at `sw.js` under the configured base path.
Add the shared headers to same-origin responses, including worker scripts.

Use runtime network-first navigation caching and cache-first same-origin GET
caching. Reload once after first control to fill the shell cache, even when preview
already supplies isolation headers. Guard the reload in session storage. Keep
model downloads and their verified Cache Storage entries separate. Leave the
model hosts to normal CORS fetches.

Observe resource timing in each page and worker global. Forward worker records
with absolute timestamps to the page's drop-scoped meter. Count selected manifest
URLs as models, all other URLs by host, and show zero only if both counts are zero.
When Timing-Allow-Origin conceals model sizes, show `size unavailable` rather than
an invented byte count. This is a browser measurement limit relative to the privacy
requested MB display; request counts remain visible.

## Verification and open work

Unit tests cover policy equality, header preservation, cache selection, offline
fallback, failure propagation, reload guarding, worker-message validation and
meter accounting. The production build must emit a self-contained `sw.js` at both
root and a non-root base path. The smoke harness filters resource messages to keep
its inference result protocol intact.

The privacy spec checks Chromium and Firefox isolation, worker CSP violations
across the browser engines, and offline reuse of synthetic shell and model bytes.
It attaches page and worker isolation flags, including WebKit's actual
`crossOriginIsolated` values. Headers and successful cache reuse alone do not
establish isolation or real Safari behavior.

The privacy fixture uses a fresh persistent WebKit profile, following the confirmed
Cache Storage behavior recorded in `docs/model-fetch.md`. Chromium and Firefox
retain ordinary isolated contexts. WebKit's synthetic offline-model check is an
expected failure because Playwright cannot route those requests after service
worker control; `docs/privacy.md` records that limit and the scan fixture's OPFS
limit. These do not establish offline inference on physical devices.

The folder intake starts the local inference pipeline. Its diary footer shows the
page and worker resource meter, including model hosts and unexpected hosts.
`tests/e2e/resume.spec.ts` checks that a processed folder can be restored after a
reload without inference or model requests when its integrity-pinned photo
fixtures are available. The privacy suite separately exercises synthetic model
bytes and the real worker's security boundary. Neither establishes offline
inference across every real card and browser. A future audio worker must also
forward its resource records.

Verification commands are in [privacy.md](../privacy.md#verification-and-remaining-acceptance).
