import { expect, test } from '@playwright/test';
import { openApp } from '../fixtures/app';

declare global {
  interface Window {
    photoWorkerMessages: unknown[];
  }
}

// WebKit reports the inline styles of its own <select> shadow tree as a violation of this CSP;
// a bare <select> under the same policy logs the same line.
const WEBKIT_SELECT_STYLE_REPORT =
  "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.";

test('the module worker loads under the app base path and rejects an unknown message', async ({
  page,
  baseURL,
  browserName,
}) => {
  const workerRequests: string[] = [];
  const startupErrors: string[] = [];
  page.on('pageerror', (error) => startupErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (browserName === 'webkit' && message.text() === WEBKIT_SELECT_STYLE_REPORT) return;
    startupErrors.push(message.text());
  });
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.includes('/assets/photo.worker-')) {
      workerRequests.push(request.url());
    }
  });
  await page.addInitScript(() => {
    const messages: unknown[] = [];
    window.photoWorkerMessages = messages;
    window.Worker = class extends Worker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        this.addEventListener('message', (event: MessageEvent<unknown>) => {
          const value = event.data;
          if (
            typeof value === 'object' &&
            value !== null &&
            'kind' in value &&
            value.kind === 'network-resources'
          )
            return;
          messages.push(value);
          if (
            typeof value === 'object' &&
            value !== null &&
            'kind' in value &&
            value.kind === 'ready'
          )
            this.postMessage({ kind: 'unknown' });
        });
        this.addEventListener('error', (event) => {
          messages.push({ workerError: event.message });
        });
      }
    };
  });

  await openApp(page);
  await expect
    .poll(async () => ({
      messages: await page.evaluate(() => window.photoWorkerMessages),
      startupErrors,
    }))
    .toEqual({
      messages: [
        { kind: 'ready', backend: 'wasm', crossOriginIsolated: true },
        {
          status: 'inference_failed',
          reason: 'Initialize photo models before sending a photo',
        },
      ],
      startupErrors: [],
    });
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  expect(workerRequests).toHaveLength(1);
  expect(workerRequests[0]?.startsWith(new URL('assets/', baseURL).href)).toBe(true);
});
