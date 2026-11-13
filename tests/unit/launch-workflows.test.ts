import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';

test('the pending model checker can only be dispatched manually', async () => {
  const workflow = await readFile('.github/workflows/models-check.yml', 'utf8');
  expect(workflow).toMatch(/workflow_dispatch:/);
  expect(workflow).not.toMatch(/^ {2}schedule:/m);
});

test('CodeQL analyzes both runtime languages with scoped security-event permission', async () => {
  const workflow = await readFile('.github/workflows/codeql.yml', 'utf8').catch(() => '');
  expect(workflow).toMatch(/pull_request:/);
  expect(workflow).toMatch(/security-events: write/);
  expect(workflow).toMatch(/github\/codeql-action\/init@v4/);
  expect(workflow).toMatch(/languages: javascript-typescript,python/);
  expect(workflow).toMatch(/github\/codeql-action\/analyze@v4/);
});

test('README describes the production WASM backend and identifies the historical evaluation backend', async () => {
  const readme = await readFile('README.md', 'utf8');
  expect(readme).not.toContain('on WebGPU when the browser has it');
  expect(readme).toMatch(/evaluation.*WebGPU/);
});

test('CI enforces the one-second sample budget in a dedicated isolated job', async () => {
  const workflow = await readFile('.github/workflows/checks.yml', 'utf8');
  expect(workflow).toMatch(/^ {2}sample-timing:/m);
  expect(workflow).toContain('WILD_TIMING_GATES: "1"');
  expect(workflow).toContain('--grep "isolated sample timing"');
});
