import type { Page } from '@playwright/test';

/**
 * Opens the built app and waits for the document that stays. The first visit registers the
 * service worker and reloads under its control, so anything evaluated earlier is lost with
 * that document.
 */
export async function openApp(page: Page, url = './'): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => {
    const [navigation] = performance.getEntriesByType('navigation');
    return (
      navigator.serviceWorker.controller !== null &&
      (navigation as PerformanceNavigationTiming | undefined)?.type === 'reload'
    );
  });
}
