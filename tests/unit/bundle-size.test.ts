import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { expect, test } from 'vitest';
import { javascriptGzipBytes } from '../../tools/bench/bundle_size';

test('the size gate sums every JavaScript asset and excludes other assets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deerdiary-size-'));
  try {
    await writeFile(join(directory, 'first.js'), 'first bundle');
    await writeFile(join(directory, 'second.js'), 'second bundle');
    await writeFile(join(directory, 'runtime.wasm'), 'excluded runtime');
    expect(await javascriptGzipBytes(directory)).toBe(
      gzipSync('first bundle').byteLength + gzipSync('second bundle').byteLength,
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('the size gate rejects an empty build', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deerdiary-size-'));
  try {
    await expect(javascriptGzipBytes(directory)).rejects.toThrow('Run npm run build first.');
  } finally {
    await rm(directory, { recursive: true });
  }
});
