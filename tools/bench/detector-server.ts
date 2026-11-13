import { copyFile, cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, preview } from 'vite';

export async function startDetectorHarness(dataDirectory = '.cache/detector-bench', port = 4186) {
  const directory = await mkdtemp(join(tmpdir(), 'deerdiary-detector-'));
  try {
    await cp(dataDirectory, join(directory, 'data'), { recursive: true });
    await build({
      publicDir: false,
      build: {
        outDir: directory,
        emptyOutDir: false,
        watch: null,
        rolldownOptions: { input: resolve('tools/bench/detector.html') },
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
      preview: { host: '127.0.0.1', port, strictPort: true, open: false },
    });
    const baseUrl = server.resolvedUrls?.local[0];
    if (!baseUrl) {
      await server.close();
      throw new Error('Benchmark server did not expose a URL');
    }
    return {
      url: new URL('tools/bench/detector.html', baseUrl).href,
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
  const harness = await startDetectorHarness();
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
