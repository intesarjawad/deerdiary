import { defineConfig } from '@playwright/test';

const isCi = Boolean(process.env.CI);
const port = process.env.PLAYWRIGHT_PORT ?? '4317';
const baseURL = new URL(process.env.BASE_URL ?? '/', `http://localhost:${port}`).href;

export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: ['**/models-persistent.spec.ts'],
  timeout: 180_000,
  expect: { timeout: 30_000 },
  forbidOnly: isCi,
  use: { baseURL, headless: true },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    {
      name: 'firefox',
      use: { browserName: 'firefox' },
      testIgnore: ['**/models-persistent.spec.ts', ...(isCi ? ['**/sample.spec.ts'] : [])],
    },
    {
      name: 'webkit',
      use: { browserName: 'webkit' },
      testIgnore: ['**/models-persistent.spec.ts', ...(isCi ? ['**/sample.spec.ts'] : [])],
    },
    {
      name: 'webkit-persistent',
      default: false,
      use: { browserName: 'webkit' },
      testMatch: '**/models-persistent.spec.ts',
      testIgnore: [],
    },
    ...(!isCi
      ? [
          {
            name: 'chromium-headful',
            default: false,
            use: { browserName: 'chromium' as const, headless: false },
          },
        ]
      : []),
  ],
  webServer: {
    command: `npm run build && npm run preview -- --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: !isCi,
  },
});
