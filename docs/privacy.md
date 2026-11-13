# Privacy enforcement

The app processes a dropped folder in the browser and displays a species diary.
The controls below protect the page and its dedicated workers.

The page's meta Content Security Policy restricts its first load. After service
worker activation, the app reloads once under worker control before creating the
photo worker. The service worker supplies the same policy as a response header,
including on dedicated worker scripts. A page's meta policy does not supply a
worker script's policy. The shared constants are in `bin/headers.mjs`; a unit test
checks that the HTML meta policy matches.

Connections are allowed to this origin, `https://huggingface.co`, and HTTPS
subdomains of `hf.co`. The model loader uses GET without a body and verifies
manifest sizes and SHA-256 hashes. CSP restricts destinations, not HTTP methods
or what code could send to an allowed destination. No analytics or telemetry is
installed. The policy allows local WebAssembly execution without enabling general
JavaScript string evaluation.

## Offline storage and isolation

`sw.js` is emitted at the configured Vite base path. Its scope is that base path.
The shell cache, `deerdiary-shell-v1`, fills at runtime: navigations try the network
first and fall back to their cached URL when fetch fails; other same-origin GETs
use the cache first. Only successful responses are cached. A first controlled
reload fills the HTML and script cache before the photo worker starts, including
when preview already supplies isolation headers. The build generates a list of on-demand chunks for the service worker to precache.
An offline URL that has never been visited is not guaranteed to work.

The service worker adds COOP `same-origin` and COEP `require-corp`, as well as CSP,
to same-origin responses. It leaves cross-origin model requests to the browser's
CORS rules and does not put those downloads in the shell cache. Verified model
bytes have their separate `deerdiary-models-v1` cache. Clear this site's browser storage
to remove cached models, app files and the service worker.

Reload is guarded in session storage per app base. If isolation remains unavailable
after that reload, the guard prevents a reload loop. Engine results are recorded in [ADR 0009](adr/0009-privacy.md).

## Network meter integration

The page starts its network meter when a folder is dropped and observes its own
resource timeline. Photo workers report their resource entries to the same meter.
The meter distinguishes the selected model URLs from other hosts.

Absolute timestamps (`performance.timeOrigin + startTime`) align all timelines.
Only entries whose request starts at or after the drop count. Repeated requests,
same-origin cache hits and unexpected hosts remain visible. Only exact selected
manifest URLs are model requests; everything else is listed by host. Pass all
selected file URLs, including labels, taxonomy and geofence. A redirect's resource
timing entry is attributed to its original URL by the browser.

Known model sizes use resource timing's encoded body bytes in decimal MB.
Cross-origin servers without Timing-Allow-Origin can conceal these byte counts;
the meter then says `size unavailable`, while retaining the request count. It
never substitutes a manifest estimate for transferred bytes. `0 requests` appears
only when both the model and other counters are zero. This counts browser resource
timing entries, including cached responses, rather than packets or transfer bytes.
Cache Storage reads themselves do not create resource timing entries. Observer
messages arrive asynchronously, so consume updates after the worker reports them.

## Verification and remaining acceptance

`tests/e2e/privacy.spec.ts` exercises the built app and real photo worker. It checks
response policies and the guarded reload from a document without isolation headers,
isolation (required on Chromium and Firefox), a blocked
`example.com` fetch with a worker CSP violation, page and worker meter entries,
and offline shell/model-cache reuse with identical verified bytes and a zero meter.
It uses the real model and meter modules, served from a test-only seeded shell
cache. All model downloads are route-fulfilled synthetic bytes; routes are removed
before going offline. No real models or user files leave the machine.

WebKit uses a fresh persistent profile within the privacy fixture because its
Playwright ephemeral contexts lose Cache Storage across reloads. The standard
`webkit` project still runs this suite. Its offline shell/model test deliberately
uses `test.fail` because Playwright cannot route synthetic model requests once a
service worker controls the page. The scan suite also deliberately uses
`test.fail` for WebKit's ephemeral-context OPFS access issue. Neither test is skipped.
The fixture supplies the configured base URL explicitly and removes its profile.

The privacy suite tests the boundaries and cache primitives with synthetic model
bytes. It does not establish the behavior of every real model or camera card.

Run the browser checks with:

```sh
CI=1 PLAYWRIGHT_PORT=19474 npx playwright test tests/e2e/privacy.spec.ts --project=chromium --project=firefox --project=webkit
```
