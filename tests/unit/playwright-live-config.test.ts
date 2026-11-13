import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import base from '../../playwright.config';
import live from '../../playwright.live.config';

const { homepage } = JSON.parse(readFileSync('package.json', 'utf8')) as { homepage: string };

test('the live config targets the published homepage', () => {
  expect(live.use?.baseURL).toBe(homepage);
  expect(new URL(homepage).protocol).toBe('https:');
});

test('the live config starts no local server', () => {
  expect(base.webServer).toBeDefined();
  expect(live.webServer).toBeUndefined();
});

test('the live config runs the chromium project only', () => {
  expect(live.projects?.map((project) => project.name)).toEqual(['chromium']);
});

test('the live config keeps the shared test settings', () => {
  expect(live.testDir).toBe(base.testDir);
  expect(live.testIgnore).toEqual(base.testIgnore);
  expect(live.timeout).toBe(base.timeout);
  expect(live.expect).toEqual(base.expect);
  expect(live.use?.headless).toBe(base.use?.headless);
});
