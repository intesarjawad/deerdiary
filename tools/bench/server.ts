import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, preview } from 'vite';

export async function startHarness() {
  const directory = await mkdtemp(join(tmpdir(), 'deerdiary-smoke-'));
  try {
    await build({
      publicDir: false,
      build: {
        outDir: directory,
        emptyOutDir: true,
        watch: null,
        rolldownOptions: { input: resolve('tools/bench/smoke.html') },
      },
    });
    const runtimeDirectory = 'node_modules/onnxruntime-web/dist';
    await mkdir(join(directory, 'ort'));
    const assets = (await readdir(runtimeDirectory)).filter(
      (name) => name.endsWith('.wasm') || name.endsWith('.mjs'),
    );
    await Promise.all(
      assets.map((name) => copyFile(join(runtimeDirectory, name), join(directory, 'ort', name))),
    );
    const server = await preview({
      publicDir: false,
      build: { outDir: directory },
      preview: {
        host: '127.0.0.1',
        port: 0,
        open: false,
        // WebKit checks a revalidated worker script's 304 against COEP and refuses it; nothing is cached.
        headers: { 'Cache-Control': 'no-store' },
      },
    });
    const baseUrl = server.resolvedUrls?.local[0];
    if (!baseUrl) {
      await server.close();
      throw new Error('Harness server did not expose a URL');
    }
    return {
      url: new URL('tools/bench/smoke.html', baseUrl).href,
      async close() {
        try {
          await server.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  const harness = await startHarness();
  console.log(harness.url);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void harness.close().catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
      });
    });
  }
}
