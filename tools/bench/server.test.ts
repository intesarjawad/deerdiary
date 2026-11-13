import { expect, test } from 'vitest';
import { startHarness } from './server';

test('serves a built harness and runtime assets without dev scripts', async () => {
  const harness = await startHarness();
  try {
    const response = await fetch(harness.url);
    expect(response.status).toBe(200);
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(response.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    const html = await response.text();
    expect(html).not.toContain('/@vite/client');
    const scriptPath = html.match(/src="([^"]+\.js)"/)?.[1];
    if (!scriptPath) throw new Error('Harness HTML must reference a built JavaScript entry');
    const script = await fetch(new URL(scriptPath, harness.url));
    expect(script.status).toBe(200);
    const entry = await script.text();
    expect(entry).not.toContain('/src/workers/ort.ts');
    const workerPath = entry.match(/\/assets\/ort-[\w-]+\.js/)?.[0];
    if (!workerPath) throw new Error('Harness entry must reference a built ORT worker');
    for (const path of [
      workerPath,
      '/ort/ort-wasm-simd-threaded.jsep.mjs',
      '/ort/ort-wasm-simd-threaded.jsep.wasm',
    ]) {
      const asset = await fetch(new URL(path, harness.url), { method: 'HEAD' });
      expect(asset.status, path).toBe(200);
      expect(asset.headers.get('cross-origin-opener-policy'), path).toBe('same-origin');
      expect(asset.headers.get('cross-origin-embedder-policy'), path).toBe('require-corp');
    }
  } finally {
    await harness.close();
  }
});
