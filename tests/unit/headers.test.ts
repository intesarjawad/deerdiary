import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { COEP, COOP, CSP } from '../../bin/headers.mjs';
import { needsControlledReload } from '../../src/app/serviceWorker';
import { withPrivacyHeaders } from '../../src/sw';

test('the first-load meta policy equals the shared response policy', async () => {
  const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
  const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
  expect(meta?.[1]).toBe(CSP);
  expect(CSP).not.toMatch(/unsafe-inline|https:\s/);
});

test('privacy headers preserve the response status, content type and body', async () => {
  const response = withPrivacyHeaders(
    new Response('script', {
      status: 201,
      statusText: 'Created',
      headers: { 'Content-Type': 'text/javascript' },
    }),
  );
  expect(response.status).toBe(201);
  expect(response.statusText).toBe('Created');
  expect(response.headers.get('Content-Type')).toBe('text/javascript');
  expect(response.headers.get('Content-Security-Policy')).toBe(CSP);
  expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe(COOP);
  expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBe(COEP);
  expect(await response.text()).toBe('script');
});

test('reloads once for first control or missing isolation, including already isolated preview', () => {
  expect(needsControlledReload(false, false, false)).toBe(true);
  expect(needsControlledReload(false, true, false)).toBe(true);
  expect(needsControlledReload(true, false, false)).toBe(true);
  expect(needsControlledReload(true, true, false)).toBe(false);
  for (const controlled of [true, false]) {
    for (const isolated of [true, false]) {
      expect(needsControlledReload(controlled, isolated, true)).toBe(false);
    }
  }
});
