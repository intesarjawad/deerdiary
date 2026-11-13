import { createServer } from 'vite';
import { expect, test } from 'vitest';

test('serves the harness and worker with cross-origin isolation headers', async () => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
  try {
    await server.listen();
    const baseUrl = server.resolvedUrls?.local[0];
    if (!baseUrl) throw new Error('Harness server did not expose a URL');
    for (const path of ['tools/bench/smoke.html', 'src/workers/ort.ts?worker_file&type=module']) {
      const response = await fetch(new URL(path, baseUrl));
      expect(response.status).toBe(200);
      expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
      expect(response.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    }
  } finally {
    await server.close();
  }
});
