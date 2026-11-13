import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { startDetectorHarness } from '../../tools/bench/detector-server';

test('serves the isolated built benchmark, local fixtures and ORT assets', async () => {
  const data = await mkdtemp(join(tmpdir(), 'deerdiary-detector-test-'));
  await writeFile(join(data, 'fixtures.json'), '{"cases":[]}');
  const harness = await startDetectorHarness(data, 0);
  try {
    const page = await fetch(harness.url);
    expect(page.status).toBe(200);
    expect(await page.text()).not.toContain('/@vite/client');
    for (const path of [
      '/data/fixtures.json',
      '/ort/ort-wasm-simd-threaded.jsep.wasm',
      '/ort/ort-wasm-simd-threaded.jsep.mjs',
    ]) {
      const response = await fetch(new URL(path, harness.url));
      expect(response.status).toBe(200);
      expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
      expect(response.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
      if (path.endsWith('.wasm'))
        expect(response.headers.get('content-type')).toBe('application/wasm');
      if (path.endsWith('.json')) expect(await response.json()).toEqual({ cases: [] });
    }
  } finally {
    await harness.close();
    await rm(data, { recursive: true, force: true });
  }
}, 30000);
