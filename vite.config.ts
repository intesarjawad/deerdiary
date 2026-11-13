import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import preact from '@preact/preset-vite';
import { defineConfig, type Plugin } from 'vite';
import { COEP, COOP } from './bin/headers.mjs';
import manifest from './models/manifest.json' with { type: 'json' };
import { LOCAL_MODEL_PATH } from './src/app/models.ts';
import { PRECACHE_LIST } from './src/sw.ts';

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': COOP,
  'Cross-Origin-Embedder-Policy': COEP,
};

/** Lists each on-demand chunk and the chunks it imports, for the service worker to cache. */
const precacheList: Plugin = {
  name: 'precache-list',
  generateBundle(_options, bundle) {
    const chunks = new Map(
      Object.values(bundle).flatMap((file) =>
        file.type === 'chunk' ? [[file.fileName, file] as const] : [],
      ),
    );
    const paths = new Set<string>();
    const add = (fileName: string) => {
      if (paths.has(fileName)) return;
      paths.add(fileName);
      for (const imported of chunks.get(fileName)?.imports ?? []) add(imported);
    };
    for (const chunk of chunks.values()) if (chunk.isDynamicEntry) add(chunk.fileName);
    this.emitFile({
      type: 'asset',
      fileName: PRECACHE_LIST,
      source: JSON.stringify([...paths].sort()),
    });
  },
};

const devCsp: Plugin = {
  name: 'dev-csp',
  apply: 'serve',
  transformIndexHtml: (html) =>
    html.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"),
};

/** Dev only: serves each export's `local_path` so unpublished models can be tried before release. */
const localModels: Plugin = {
  name: 'local-models',
  apply: 'serve',
  configureServer(server) {
    const paths = new Map(
      [...manifest.local_exports.files, ...manifest.local_detector_exports.files].map((file) => [
        file.id,
        resolve(file.local_path),
      ]),
    );
    server.middlewares.use(LOCAL_MODEL_PATH, (req, res, next) => {
      const path = paths.get(decodeURIComponent((req.url ?? '').slice(1)));
      if (!path) return next();
      const stream = createReadStream(path);
      stream.on('error', () => {
        res.statusCode = 404;
        res.end(`Missing ${path}. Build the exports first: see docs/development.md.`);
      });
      stream.on('open', () => {
        res.setHeader('Content-Type', 'application/octet-stream');
        stream.pipe(res);
      });
    });
  },
};

export default defineConfig({
  base: process.env.BASE_URL ?? '/',
  plugins: [
    preact({ exclude: [/node_modules/, /\/src\/workers\//] }),
    precacheList,
    localModels,
    devCsp,
  ],
  optimizeDeps: { include: ['onnxruntime-web/webgpu'] },
  build: {
    rolldownOptions: {
      input: { app: resolve('index.html'), sw: resolve('src/sw.ts') },
      output: {
        entryFileNames: (entry) => (entry.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
});
