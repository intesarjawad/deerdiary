import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base } from '@playwright/test';

// WebKit's ephemeral contexts lose Cache Storage across reloads and refuse Blob rows in IndexedDB.
export const test = base.extend({
  context: async ({ browserName, browser, playwright, headless, baseURL }, use) => {
    const options = { ...(baseURL ? { baseURL } : {}), serviceWorkers: 'allow' as const };
    if (browserName !== 'webkit') {
      const context = await browser.newContext(options);
      try {
        await use(context);
      } finally {
        await context.close();
      }
      return;
    }
    const profile = await mkdtemp(join(tmpdir(), 'deerdiary-privacy-webkit-'));
    try {
      const context = await playwright.webkit.launchPersistentContext(profile, {
        ...options,
        headless,
      });
      try {
        await use(context);
      } finally {
        await context.close();
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  },
});
