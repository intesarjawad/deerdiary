import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

export const JAVASCRIPT_GZIP_BUDGET_BYTES = 250_000;

export async function javascriptGzipBytes(directory: string): Promise<number> {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.js'));
  if (names.length === 0) {
    throw new Error(`No JavaScript assets in ${directory}. Run npm run build first.`);
  }
  const sizes = await Promise.all(
    names.map(async (name) => gzipSync(await readFile(join(directory, name))).byteLength),
  );
  return sizes.reduce((total, bytes) => total + bytes, 0);
}

if (import.meta.main) {
  const bytes = await javascriptGzipBytes('dist/assets');
  console.log(`JavaScript gzip: ${bytes} bytes; budget < ${JAVASCRIPT_GZIP_BUDGET_BYTES} bytes`);
  if (bytes >= JAVASCRIPT_GZIP_BUDGET_BYTES) {
    process.exitCode = 1;
  }
}
