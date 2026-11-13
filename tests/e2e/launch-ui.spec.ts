import { expect } from '@playwright/test';
import { openApp } from '../fixtures/app';
import { test } from '../fixtures/storage';

test('mobile intake precedes the sheet and reduced motion disables face transitions', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openApp(page);
  const intake = page.getByRole('region', { name: 'Folder intake' });
  const sheet = page.getByRole('region', { name: 'Field sheet for the sample card' });
  await expect(sheet).toBeVisible();
  expect((await intake.boundingBox())?.y).toBeLessThan((await sheet.boundingBox())?.y ?? 0);
  await page.getByRole('button', { name: 'Try the sample' }).click();
  await expect(page.getByRole('region', { name: 'Species diary' })).toBeVisible();
  expect(
    await page.locator('.faces').evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toBe('0s');
  expect(
    await page
      .locator('.face')
      .first()
      .evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toBe('0s');
});

test('sample uses originals in the reel and returns focus after correction', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Try the sample' }).click();
  await page
    .getByRole('button', { name: /^Open photo from/ })
    .first()
    .click();
  await expect(page.locator('dialog[open] img')).toHaveAttribute('src', /\/sample\/(?!thumbs\/)/);
  await page.getByRole('button', { name: 'Close' }).click();
  const reelImage = page.locator('.reel-shot.is-active img');
  await expect(reelImage).toHaveAttribute('src', /\/sample\/(?!thumbs\/)/);
  const stage = page.locator('.reel-stage');
  expect(await stage.evaluate((el) => el.clientWidth / el.clientHeight)).toBeCloseTo(16 / 9, 1);
  const correct = page.getByRole('button', { name: /^Correct / }).first();
  await correct.click();
  const input = page.getByRole('combobox', { name: 'Correct species' });
  await input.fill('cat');
  await expect(
    page.getByRole('listbox', { name: 'Species matching cat' }).getByRole('option').first(),
  ).toBeVisible();
  await input.press('Enter');
  await expect(correct).toBeFocused();
});

test('an imported unbroken species name fits a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openApp(page);
  const { dropCard, importPredictions, readPredictions } = await import('../fixtures/predictions');
  const data = JSON.stringify(await readPredictions('predictions.speciesnet.json')).replaceAll(
    'white-tailed deer',
    'SouthwesternGreaterLongTailedForestAnimalWithAnUnbrokenImportedLabel',
  );
  await importPredictions(page, 'long.json', data);
  await dropCard(page);
  await expect(page.getByRole('region', { name: 'Species diary' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`all burst photos remain reachable at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openApp(page);
    await page.getByRole('button', { name: 'Try the sample' }).click();
    await page
      .getByRole('button', { name: /^Open photo from.*3 photos/ })
      .first()
      .click();
    const dialog = page.locator('dialog[open]');
    const previous = dialog.getByRole('button', { name: 'Previous photo' });
    while (await previous.isEnabled()) await previous.click();
    await expect(dialog.getByRole('status')).toHaveText('Photo 1 of 3');
    const sources = new Set<string | null>();
    for (let index = 1; index <= 3; index++) {
      await expect(dialog.getByRole('status')).toHaveText(`Photo ${index} of 3`);
      sources.add(await dialog.locator('img').getAttribute('src'));
      if (index < 3) await dialog.getByRole('button', { name: 'Next photo' }).click();
    }
    expect(sources.size).toBe(3);
    await expect(dialog.getByRole('button', { name: 'Next photo' })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Close' }).click();
  });
  test(`keyboard options stay inside the list at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openApp(page);
    await page.getByRole('button', { name: 'Try the sample' }).click();
    const correct = page.getByRole('button', { name: /^Correct / }).first();
    await correct.click();
    const input = page.getByRole('combobox', { name: 'Correct species' });
    await input.fill('bear');
    for (let index = 0; index < 9; index++) await input.press('ArrowDown');
    const activeId = await input.getAttribute('aria-activedescendant');
    expect(activeId).toBeTruthy();
    await expect
      .poll(() =>
        page.evaluate((id) => {
          const option = id ? document.getElementById(id) : null;
          const list = option?.closest('[role="listbox"]');
          if (!option || !list) return false;
          const row = option.getBoundingClientRect();
          const box = list.getBoundingClientRect();
          return row.top >= box.top && row.bottom <= box.bottom;
        }, activeId),
      )
      .toBe(true);
    await input.press('Escape');
    await input.press('Escape');
  });
  test(`reel end card text fits the frame at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openApp(page);
    await page.getByRole('button', { name: 'Try the sample' }).click();
    const stage = page.getByRole('slider', { name: 'Species reel' });
    await stage.focus();
    await stage.press('End');
    const end = page.locator('.reel-end.is-active');
    await expect(end).toBeVisible();
    // Under load the display face can land after the card first paints, so measure settled layout.
    await page.evaluate(() => document.fonts.ready);
    await expect
      .poll(() =>
        end.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return [...element.children].every((child) => {
            const row = child.getBoundingClientRect();
            return (
              row.top >= box.top &&
              row.bottom <= box.bottom &&
              row.left >= box.left &&
              row.right <= box.right
            );
          });
        }),
      )
      .toBe(true);
  });
}

test('a restored backup shows placeholders and attaches originals without rerunning models', async ({
  page,
}) => {
  await openApp(page);
  await page.getByLabel('Import a session file').setInputFiles('public/sample/predictions.json');
  await page.getByRole('button', { name: 'Open this session' }).click();
  await expect(page.getByRole('region', { name: 'Species diary' })).toBeVisible();
  await expect(page.locator('.reel-missing').first()).toBeAttached();
  await expect(page.getByText('This diary has no photos attached.')).toBeVisible();
  expect(
    await page
      .locator('img')
      .evaluateAll(
        (images) =>
          images.filter(
            (image) =>
              image instanceof HTMLImageElement && image.complete && image.naturalWidth === 0,
          ).length,
      ),
  ).toBe(0);
  await expect(
    page.getByText('Reel export needs the original photos.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export reel', exact: true })).toHaveCount(0);
  await page.evaluate(() =>
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: undefined }),
  );
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach originals', exact: true }).click();
  await (await chooser).setFiles('public/sample');
  await expect(
    page.getByText('Originals attached to this diary. Saved labels and corrections are kept.'),
  ).toBeVisible();
  await expect(page.getByText('Loading the photo models.', { exact: true })).toHaveCount(0);
  await expect(page.locator('.reel-shot.is-active img')).toBeVisible();
  await expect(
    page.getByText('Reel export needs the original photos.', { exact: false }),
  ).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'History' }).getByRole('article')).toHaveCount(1);
});
