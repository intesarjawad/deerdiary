import { readFileSync } from 'node:fs';
import { defineConfig } from '@playwright/test';
import base from './playwright.config';

const { homepage } = JSON.parse(readFileSync('package.json', 'utf8')) as { homepage?: unknown };
if (typeof homepage !== 'string') {
  throw new Error('package.json has no homepage; the live tests need the published URL.');
}

// The published site is already running, so the local build and preview server are left out.
const { webServer: _localServer, ...shared } = base;

export default defineConfig({
  ...shared,
  use: { ...shared.use, baseURL: homepage },
  projects: (shared.projects ?? []).filter((project) => project.name === 'chromium'),
});
