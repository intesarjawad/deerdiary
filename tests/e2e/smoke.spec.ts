import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startHarness } from '../../tools/bench/server';

interface Tensor {
  name: string;
  shape: (string | number)[];
  dtype: 'FLOAT' | 'INT64';
}
interface Model {
  id: string;
  url?: string;
  local_path?: string;
  bytes: number;
  sha256: string;
  inputs?: Tensor[];
  outputs?: Tensor[];
}
interface Result {
  backend: string;
  medianMs?: number;
  shapes?: Record<string, number[]>;
  crossOriginIsolated: boolean;
  error?: string;
}

test('runs manifest models on WebGPU and WASM', async ({ page }) => {
  test.setTimeout(3_600_000);
  const manifest: {
    files: Model[];
    local_exports: { files: Model[] };
    local_detector_exports: { files: Model[] };
  } = JSON.parse(await readFile('models/manifest.json', 'utf8'));
  const cache = process.env.HF_HUB_CACHE ?? join(tmpdir(), 'deerdiary-models');
  const paths = new Map<string, string>();
  for (const model of manifest.files.filter((entry) => entry.inputs)) {
    if (!model.url) throw new Error(`Missing model URL: ${model.id}`);
    const url = new URL(model.url);
    const parts = url.pathname.split('/').filter(Boolean);
    const [owner, repository, , revision, ...name] = parts;
    if (!owner || !repository || !revision || !name.length)
      throw new Error(`Invalid model URL: ${model.url}`);
    const path = join(cache, `models--${owner}--${repository}`, 'snapshots', revision, ...name);
    if (!existsSync(path)) {
      console.log(JSON.stringify({ model: model.id, skipped: 'cached file absent' }));
      continue;
    }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    expect((await stat(path)).size, model.id).toBe(model.bytes);
    expect(hash.digest('hex'), model.id).toBe(model.sha256);
    paths.set(model.id, path);
  }
  const localModels = [...manifest.local_exports.files, ...manifest.local_detector_exports.files];
  for (const model of localModels) {
    if (!model.local_path) throw new Error(`Missing local path: ${model.id}`);
    if (!existsSync(model.local_path)) {
      console.log(JSON.stringify({ model: model.id, skipped: 'local file absent' }));
      continue;
    }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(model.local_path)) hash.update(chunk);
    expect((await stat(model.local_path)).size, model.id).toBe(model.bytes);
    expect(hash.digest('hex'), model.id).toBe(model.sha256);
    paths.set(model.id, model.local_path);
  }
  test.skip(
    paths.size === 0,
    'No manifest-pinned ONNX models are cached locally. Build the unpublished exports or provision the Hugging Face cache to run model smoke inference.',
  );
  const harness = await startHarness();
  const server = createServer((request, response) => {
    const path = paths.get(decodeURIComponent((request.url ?? '').slice(1)));
    if (!path) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader('Access-Control-Allow-Origin', '*');
    createReadStream(path).pipe(response);
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Model server did not start');
    const response = await page.goto(harness.url);
    expect(response?.headers()['cross-origin-opener-policy']).toBe('same-origin');
    expect(response?.headers()['cross-origin-embedder-policy']).toBe('require-corp');
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    for (const model of [...manifest.files, ...localModels].filter(
      (entry) => entry.inputs && paths.has(entry.id),
    )) {
      const input = model.inputs?.[0];
      if (!input || !model.inputs || !model.outputs)
        throw new Error(`Missing tensor metadata: ${model.id}`);
      const inputs = model.inputs.map((tensor) => ({
        name: tensor.name,
        dtype: tensor.dtype,
        shape: tensor.shape.map((dimension, index) =>
          typeof dimension === 'number' ? dimension : index === 0 ? 1 : 960,
        ),
      }));
      const shape = inputs[0]?.shape;
      for (const backend of ['webgpu', 'wasm'] as const) {
        const result = await page.evaluate(
          async (request) => {
            const harness = window as typeof window & {
              runModel: (value: typeof request) => Promise<Result>;
            };
            return harness.runModel(request);
          },
          {
            url: `http://127.0.0.1:${address.port}/${encodeURIComponent(model.id)}`,
            inputs,
            backend,
          },
        );
        console.log(JSON.stringify({ model: model.id, input: shape, ...result }));
        expect.soft(result.error, `${model.id} ${backend}`).toBeUndefined();
        expect.soft(result.crossOriginIsolated, `${model.id} ${backend}`).toBe(true);
        for (const output of model.outputs) {
          expect
            .soft(result.shapes?.[output.name], `${model.id} ${backend} ${output.name}`)
            .toEqual(
              output.shape.map((dimension) => (typeof dimension === 'number' ? dimension : 1)),
            );
        }
      }
    }
  } finally {
    await harness.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
