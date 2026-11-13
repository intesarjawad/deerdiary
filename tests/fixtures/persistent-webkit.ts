import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base } from '@playwright/test';

export const test = base.extend({
  context: async ({ playwright, headless }, use) => {
    const profile = await mkdtemp(join(tmpdir(), 'deerdiary-webkit-cache-'));
    try {
      const context = await playwright.webkit.launchPersistentContext(profile, { headless });
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
