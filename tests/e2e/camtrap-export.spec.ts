import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { type Download, expect } from '@playwright/test';
import { openApp } from '../fixtures/app';
import { test } from '../fixtures/storage';

const execute = promisify(execFile);

test('Camtrap form validates, restores session details and downloads an official data package', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openApp(page);
  await page.getByRole('button', { name: 'Try the sample', exact: true }).click();
  await page.getByRole('button', { name: 'Download Camtrap DP', exact: true }).click();
  const form = page.getByRole('form', { name: 'Camtrap DP export details' });
  await expect(form).toBeVisible();
  await expect(form.getByLabel('Project title', { exact: true })).toBeFocused();
  const downloads: Download[] = [];
  page.on('download', (download) => downloads.push(download));
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });

  await form.getByRole('button', { name: 'Download package', exact: true }).click();
  await expect(form.getByLabel('Project title', { exact: true })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await expect(form.getByLabel('Project title', { exact: true })).toBeFocused();
  await form.getByLabel('Project title', { exact: true }).fill('Camera survey');
  await form.getByLabel('Contributor name', { exact: true }).fill('Test researcher');
  await form.getByLabel('Sampling design', { exact: true }).selectOption('systematicRandom');
  // These are user-entered test coordinates, not claimed locations of the Caltech sample.
  await form.getByLabel('Latitude for sample', { exact: true }).fill('91');
  await form.getByLabel('Longitude for sample', { exact: true }).fill('-181');
  await form.getByRole('button', { name: 'Download package', exact: true }).click();
  await expect(form.getByText('Enter a latitude from -90 to 90.', { exact: true })).toBeVisible();
  await expect(
    form.getByText('Enter a longitude from -180 to 180.', { exact: true }),
  ).toBeVisible();
  expect(downloads).toHaveLength(0);
  await form.getByLabel('Latitude for sample', { exact: true }).fill('34.1');
  await form.getByLabel('Longitude for sample', { exact: true }).fill('-118.2');
  await expect(form.getByLabel('Latitude for sample', { exact: true })).toHaveAttribute(
    'aria-invalid',
    'false',
  );

  await expect
    .poll(() =>
      page.evaluate(async () => {
        const request = indexedDB.open('deerdiary');
        const db = await new Promise<IDBDatabase>((accept, reject) => {
          request.onsuccess = () => accept(request.result);
          request.onerror = () => reject(request.error);
        });
        const records = await new Promise<
          { camtrap?: { locations?: Record<string, { longitude: string }> } }[]
        >((accept, reject) => {
          const get = db.transaction('sessions').objectStore('sessions').getAll();
          get.onsuccess = () => accept(get.result);
          get.onerror = () => reject(get.error);
        });
        db.close();
        return records[0]?.camtrap?.locations?.sample?.longitude;
      }),
    )
    .toBe('-118.2');

  await page.reload();
  await page.getByRole('button', { name: 'Open this session', exact: true }).first().click();
  await page.getByRole('button', { name: 'Download Camtrap DP', exact: true }).click();
  await expect(form.getByLabel('Project title', { exact: true })).toHaveValue('Camera survey');
  await expect(form.getByLabel('Contributor name', { exact: true })).toHaveValue('Test researcher');
  await expect(form.getByLabel('Sampling design', { exact: true })).toHaveValue('systematicRandom');
  await expect(form.getByLabel('Latitude for sample', { exact: true })).toHaveValue('34.1');
  await expect(form.getByLabel('Longitude for sample', { exact: true })).toHaveValue('-118.2');
  await form.getByLabel('Project title', { exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(form.getByLabel('Contributor name', { exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(form.getByLabel('Sampling design', { exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(form.getByLabel('Contributor name', { exact: true })).toBeFocused();
  await form.getByLabel('Project title', { exact: true }).focus();

  const shots = process.env.CAMTRAP_SCREENSHOT_DIR ?? testInfo.outputPath('screenshots');
  await mkdir(shots, { recursive: true });
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await form.evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: join(shots, `camtrap-form-${width}x${height}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }

  await form.getByLabel('Longitude for sample', { exact: true }).press('Enter');
  await expect.poll(() => downloads.length).toBe(4);
  expect(dialogs).toEqual([]);
  const directory = testInfo.outputPath('package');
  await mkdir(directory, { recursive: true });
  for (const download of downloads)
    await download.saveAs(join(directory, download.suggestedFilename()));
  expect(downloads.map((download) => download.suggestedFilename()).sort()).toEqual([
    'datapackage.json',
    'deployments.csv',
    'media.csv',
    'observations.csv',
  ]);
  const descriptor = JSON.parse(await readFile(join(directory, 'datapackage.json'), 'utf8'));
  expect(descriptor.project.title).toBe('Camera survey');
  expect(descriptor.contributors).toEqual([{ title: 'Test researcher' }]);
  expect(await readFile(join(directory, 'deployments.csv'), 'utf8')).toContain('34.1,-118.2');
  const python = process.env.CAMTRAP_PYTHON ?? resolve('tools/.venv/bin/python');
  const { stdout, stderr } = await execute(python, [
    resolve('tools/eval/validate_exports.py'),
    '--camtrap-only',
    directory,
  ]);
  await writeFile(testInfo.outputPath('frictionless.log'), stdout + stderr);
  expect(stdout).toContain('VALID');
  expect(stdout).not.toContain('INVALID');
});
