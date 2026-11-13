import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, preview } from 'vite';
import manifest from '../../models/manifest.json' with { type: 'json' };
import raw from '../golden/speciesnet_cli.raw.json' with { type: 'json' };

/** Absent unpublished weights and upstream photos are optional; corrupt present inputs still fail. */
export function photoFixtureSkipReason(): string | undefined {
  const paths = [
    ...manifest.local_exports.files.map((model) => model.local_path),
    ...manifest.local_detector_exports.files
      .filter(
        (model) => model.id === manifest.default_detector || model.role === 'detector_reference',
      )
      .map((model) => model.local_path),
    ...raw.predictions.map((prediction) => prediction.filepath),
  ];
  const missing = paths.filter((path) => !existsSync(path));
  return missing.length === 0
    ? undefined
    : `Missing ${missing.length} local inference fixtures (first: ${missing[0]}). ONNX exports are unpublished and upstream golden photos are not bundled; provision the manifest-pinned files to run inference parity.`;
}

export async function startPhotoHarness({
  modelRoot = '.',
  photos = raw.predictions,
}: {
  modelRoot?: string;
  photos?: readonly { filepath: string }[];
} = {}) {
  const files = new Map<string, string>();
  const models = [
    ...manifest.local_exports.files,
    ...manifest.local_detector_exports.files.filter(
      (model) => model.id === manifest.default_detector || model.role === 'detector_reference',
    ),
  ];
  for (const model of models) {
    const path = join(modelRoot, model.local_path);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if ((await stat(path)).size !== model.bytes || hash.digest('hex') !== model.sha256)
      throw new Error(`Test model failed integrity check: ${model.id}`);
    files.set(`/${model.id}`, path);
  }
  for (const prediction of photos) {
    files.set(`/photos/${prediction.filepath.split('/').pop()}`, prediction.filepath);
  }
  const directory = await mkdtemp(join(tmpdir(), 'deerdiary-photo-'));
  const assets = createServer((request, response) => {
    const path = files.get(request.url ?? '');
    if (!path) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    createReadStream(path)
      .on('error', () => response.destroy())
      .pipe(response);
  });
  try {
    await build({
      publicDir: false,
      build: {
        outDir: directory,
        emptyOutDir: true,
        watch: null,
        rolldownOptions: { input: resolve('tests/fixtures/photo.html') },
      },
    });
    await mkdir(join(directory, 'ort'));
    const runtimeDirectory = 'node_modules/onnxruntime-web/dist';
    const runtimeAssets = (await readdir(runtimeDirectory)).filter(
      (name) => name.endsWith('.wasm') || name.endsWith('.mjs'),
    );
    await Promise.all(
      runtimeAssets.map((name) =>
        copyFile(join(runtimeDirectory, name), join(directory, 'ort', name)),
      ),
    );
    const server = await preview({
      publicDir: false,
      build: { outDir: directory },
      preview: { host: '127.0.0.1', port: 0, open: false },
    });
    try {
      await new Promise<void>((resolve) => assets.listen(0, '127.0.0.1', resolve));
      const address = assets.address();
      const baseUrl = server.resolvedUrls?.local[0];
      if (!baseUrl || !address || typeof address === 'string')
        throw new Error('Photo test server did not start');
      return {
        url: new URL('tests/fixtures/photo.html', baseUrl).href,
        modelBaseUrl: `http://127.0.0.1:${address.port}/`,
        async close() {
          try {
            await server.close();
          } finally {
            try {
              await new Promise<void>((resolve, reject) =>
                assets.close((error) => (error ? reject(error) : resolve())),
              );
            } finally {
              await rm(directory, { recursive: true, force: true });
            }
          }
        },
      };
    } catch (error) {
      await server.close();
      throw error;
    }
  } catch (error) {
    if (assets.listening) await new Promise<void>((resolve) => assets.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
