import { fileURLToPath } from 'node:url';
import preact from '@preact/preset-vite';
import { build } from 'vite';

export async function sessionShell(): Promise<{ script: string; css: string }> {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    publicDir: false,
    plugins: [
      {
        name: 'session-inputs',
        enforce: 'pre',
        resolveId(id) {
          if (id === './app/photoModels')
            return fileURLToPath(new URL('./session-models.ts', import.meta.url));
          if (id === './app/serviceWorker') return '\0session-offline';
        },
        load(id) {
          if (id === '\0session-offline')
            return 'export async function enableOfflineApp() { return true; }';
        },
      },
      preact(),
    ],
    build: {
      write: false,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL('../../src/main.tsx', import.meta.url)),
        formats: ['es'],
      },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const files = outputs.flatMap((output) => ('output' in output ? output.output : []));
  const script = files
    .filter((file) => file.type === 'chunk')
    .map((file) => file.code)
    .join('\n');
  const css = files
    .flatMap((file) =>
      file.type === 'asset' && file.fileName.endsWith('.css') ? [file.source] : [],
    )
    .join('\n');
  return { script, css };
}
