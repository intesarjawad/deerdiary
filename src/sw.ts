/// <reference lib="webworker" />
import { COEP, COOP, CSP } from '../bin/headers.mjs';

export const SHELL_CACHE_NAME = 'deerdiary-shell-v1';
/** Written by the build: the chunks the app imports only on demand, relative to the app base. */
export const PRECACHE_LIST = 'precache.json';

type RuntimeEnvironment = {
  origin: string;
  fetch: typeof fetch;
  cache: Pick<Cache, 'match' | 'put'>;
};

export function handlesRequest(request: Request, origin: string): boolean {
  return request.method === 'GET' && new URL(request.url).origin === origin;
}

export function withPrivacyHeaders(response: Response): Response {
  if (response.type === 'opaque' || response.type === 'opaqueredirect') return response;
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', CSP);
  headers.set('Cross-Origin-Opener-Policy', COOP);
  headers.set('Cross-Origin-Embedder-Policy', COEP);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// A host may answer with `Vary: Origin`, and a module import and a fetch of the same file differ
// in that header, so a lookup that honours Vary misses files that are in the cache.
const ANY_VARIANT: CacheQueryOptions = { ignoreVary: true };

/** Navigations refresh the shell; other same-origin GETs work from the runtime cache. */
export async function serveRequest(
  request: Request,
  environment: RuntimeEnvironment,
): Promise<Response> {
  if (!handlesRequest(request, environment.origin)) return environment.fetch(request);
  const { cache } = environment;
  if (request.mode !== 'navigate') {
    const cached = await cache.match(request, ANY_VARIANT);
    if (cached) return withPrivacyHeaders(cached);
  }
  let response: Response;
  try {
    response = await environment.fetch(request);
  } catch (error) {
    const cached = await cache.match(request, ANY_VARIANT);
    if (cached) return withPrivacyHeaders(cached);
    throw error;
  }
  if (response.ok) {
    try {
      await cache.put(request, response.clone());
    } catch (error) {
      console.warn('Could not cache the online response.', error);
    }
  }
  return withPrivacyHeaders(response);
}

/**
 * A first visit never loads an on-demand chunk such as the reel's MP4 writer, so the runtime cache
 * alone would leave that feature broken offline.
 */
export async function precacheLazyChunks(
  baseURL: string,
  environment: { fetch: typeof fetch; cache: Pick<Cache, 'addAll'> },
): Promise<void> {
  const response = await environment.fetch(new URL(PRECACHE_LIST, baseURL).href);
  if (!response.ok) throw new Error(`Could not read ${PRECACHE_LIST}: HTTP ${response.status}.`);
  const paths: unknown = await response.json();
  const urls =
    Array.isArray(paths) && paths.every((path): path is string => typeof path === 'string')
      ? paths.map((path) => new URL(path, baseURL).href)
      : undefined;
  if (urls === undefined || urls.some((url) => !url.startsWith(baseURL))) {
    throw new Error(`${PRECACHE_LIST} is not a list of paths under ${baseURL}.`);
  }
  await environment.cache.addAll(urls);
}

if (typeof ServiceWorkerGlobalScope !== 'undefined' && self instanceof ServiceWorkerGlobalScope) {
  const scope: ServiceWorkerGlobalScope = self;
  scope.addEventListener('install', (event) =>
    event.waitUntil(
      scope.caches
        .open(SHELL_CACHE_NAME)
        .then((cache) =>
          precacheLazyChunks(scope.registration.scope, { fetch: scope.fetch.bind(scope), cache }),
        )
        // The app still works online without these chunks; failing the install would stop it.
        .catch((error: unknown) => console.warn('Could not precache the on-demand chunks.', error))
        .then(() => scope.skipWaiting()),
    ),
  );
  scope.addEventListener('activate', (event) => event.waitUntil(scope.clients.claim()));
  scope.addEventListener('fetch', (event) => {
    if (!handlesRequest(event.request, scope.location.origin)) return;
    event.respondWith(
      scope.caches.open(SHELL_CACHE_NAME).then((cache) =>
        serveRequest(event.request, {
          origin: scope.location.origin,
          fetch: scope.fetch.bind(scope),
          cache,
        }),
      ),
    );
  });
}
