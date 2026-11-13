import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';

const bundles = new Map<string, Promise<string>>();

/** Bundles one app module the way the build does, so a page can import it as it is. */
export function browserModule(entry: string): Promise<string> {
  let bundle = bundles.get(entry);
  if (!bundle) {
    bundle = bundleModule(entry);
    bundles.set(entry, bundle);
  }
  return bundle;
}

async function bundleModule(entry: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'deerdiary-module-'));
  try {
    await build({
      configFile: false,
      logLevel: 'silent',
      publicDir: false,
      build: {
        outDir: directory,
        emptyOutDir: true,
        minify: false,
        lib: { entry: resolve(entry), formats: ['es'], fileName: () => 'module.js' },
        // The page imports one file, so lazily loaded dependencies must be inside it.
        rolldownOptions: { output: { codeSplitting: false } },
      },
    });
    return await readFile(join(directory, 'module.js'), 'utf8');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
