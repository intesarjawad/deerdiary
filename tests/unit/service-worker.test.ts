import { expect, test, vi } from 'vitest';
import { CSP } from '../../bin/headers.mjs';
import { handlesRequest, PRECACHE_LIST, precacheLazyChunks, serveRequest } from '../../src/sw';

const origin = 'https://local.test';
function setup() {
  const entries = new Map<string, Response>();
  const cache = {
    match: vi.fn(async (request: Request) => entries.get(request.url)?.clone()),
    put: vi.fn(async (request: Request, response: Response) => {
      entries.set(request.url, response.clone());
    }),
  };
  const environment = {
    origin,
    cache,
    fetch: vi.fn<typeof fetch>(async () => new Response('fresh')),
  };
  return { entries, environment };
}

function navigation(): Request {
  const request = new Request(`${origin}/deerdiary/`);
  Object.defineProperty(request, 'mode', { value: 'navigate' });
  return request;
}

test('intercepts only same-origin GETs', () => {
  expect(handlesRequest(new Request(`${origin}/deerdiary/assets/app.js`), origin)).toBe(true);
  expect(handlesRequest(new Request('https://huggingface.co/model'), origin)).toBe(false);
  expect(handlesRequest(new Request(origin, { method: 'POST', body: 'private' }), origin)).toBe(
    false,
  );
});

test('runtime-caches assets and adds CSP on both network and cached scripts', async () => {
  const { environment } = setup();
  const request = new Request(`${origin}/deerdiary/assets/worker.js`);
  for (let i = 0; i < 2; i++) {
    const response = await serveRequest(request, environment);
    expect(response.headers.get('Content-Security-Policy')).toBe(CSP);
    expect(await response.text()).toBe('fresh');
  }
  expect(environment.fetch).toHaveBeenCalledOnce();
  expect(environment.cache.put).toHaveBeenCalledOnce();
});

test('navigations refresh the cache, then reuse the last successful document offline', async () => {
  const { entries, environment } = setup();
  const request = navigation();
  entries.set(request.url, new Response('old'));
  expect(await (await serveRequest(request, environment)).text()).toBe('fresh');
  environment.fetch.mockRejectedValue(new Error('offline'));
  const response = await serveRequest(request, environment);
  expect(await response.text()).toBe('fresh');
  expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
  expect(environment.fetch).toHaveBeenCalledTimes(2);
});

test('serves the online navigation and logs when the cache quota is exceeded', async () => {
  const { entries, environment } = setup();
  const request = navigation();
  entries.set(request.url, new Response('old'));
  const error = new DOMException('Storage is full', 'QuotaExceededError');
  environment.cache.put.mockRejectedValue(error);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const response = await serveRequest(request, environment);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('fresh');
    expect(response.headers.get('Content-Security-Policy')).toBe(CSP);
    expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
    expect(await entries.get(request.url)?.text()).toBe('old');
    expect(warning).toHaveBeenCalledWith(expect.any(String), error);
  } finally {
    warning.mockRestore();
  }
});

test('does not cache failed HTTP responses or replace a good cached navigation', async () => {
  const { entries, environment } = setup();
  const request = navigation();
  entries.set(request.url, new Response('old'));
  environment.fetch.mockResolvedValue(new Response('unavailable', { status: 503 }));
  expect((await serveRequest(request, environment)).status).toBe(503);
  expect(environment.cache.put).not.toHaveBeenCalled();
  expect(await entries.get(request.url)?.text()).toBe('old');
});

test('propagates offline cache misses and passes cross-origin requests through without caching', async () => {
  const { environment } = setup();
  environment.fetch.mockRejectedValue(new Error('offline'));
  await expect(serveRequest(new Request(`${origin}/missing`), environment)).rejects.toThrow(
    'offline',
  );
  environment.fetch.mockResolvedValue(new Response('model'));
  const response = await serveRequest(new Request('https://huggingface.co/model'), environment);
  expect(await response.text()).toBe('model');
  expect(response.headers.has('Content-Security-Policy')).toBe(false);
  expect(environment.cache.put).not.toHaveBeenCalled();
});

function precacheSetup(list: Response | Error) {
  const cache = { addAll: vi.fn(async (_urls: string[]) => {}) };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    if (list instanceof Error) throw list;
    return list;
  });
  return { cache, fetch };
}

test('caches every chunk the build lists, resolved against the app base', async () => {
  const environment = precacheSetup(
    Response.json(['assets/mediabunny-abc.js', 'assets/shared-def.js']),
  );

  await precacheLazyChunks(`${origin}/deerdiary/`, environment);

  expect(environment.fetch).toHaveBeenCalledWith(`${origin}/deerdiary/${PRECACHE_LIST}`);
  expect(environment.cache.addAll).toHaveBeenCalledWith([
    `${origin}/deerdiary/assets/mediabunny-abc.js`,
    `${origin}/deerdiary/assets/shared-def.js`,
  ]);
});

test('rejects a missing or malformed chunk list without caching anything', async () => {
  for (const [list, message] of [
    [new Response('gone', { status: 404 }), 'HTTP 404'],
    [Response.json({ files: [] }), 'not a list of paths'],
    [Response.json(['https://example.com/a.js']), 'not a list of paths'],
  ] as const) {
    const environment = precacheSetup(list);
    await expect(precacheLazyChunks(`${origin}/`, environment)).rejects.toThrow(message);
    expect(environment.cache.addAll).not.toHaveBeenCalled();
  }
});
