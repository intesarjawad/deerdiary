#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createReadStream, promises, readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COEP, COOP, CSP } from './headers.mjs';

const DEFAULT_PORT = 4321;
const HOST = '127.0.0.1';
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};
const PRIVACY_HEADERS = {
  'Content-Security-Policy': CSP,
  'Cross-Origin-Opener-Policy': COOP,
  'Cross-Origin-Embedder-Policy': COEP,
};

export function parseArgs(argv) {
  const options = { port: DEFAULT_PORT, open: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-open') {
      options.open = false;
    } else if (arg === '--port' || arg?.startsWith('--port=')) {
      if (arg === '--port') index += 1;
      const value = arg === '--port' ? argv[index] : arg.slice('--port='.length);
      const port = Number(value);
      if (!value || !Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`--port needs a whole number from 0 to 65535, not "${value ?? ''}".`);
      }
      options.port = port;
    } else {
      throw new Error(`Unknown option "${arg}". Use --port <number> and --no-open.`);
    }
  }
  return options;
}

export function nodeVersionError(current, range) {
  const wanted = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range);
  if (!wanted) return null;
  const need = [wanted[1], wanted[2], wanted[3]].map((part) => Number(part ?? 0));
  const have = current.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const found = have[index] ?? 0;
    const required = need[index] ?? 0;
    if (found === required) continue;
    if (found > required) return null;
    return `deerdiary needs Node ${range.replace(/^>=\s*/, '')} or newer, but this is Node ${current}. Install a current Node from https://nodejs.org/ and run it again.`;
  }
  return null;
}

function resolveInside(root, rawUrl) {
  if (!rawUrl.startsWith('/')) return null;
  let pathname;
  try {
    pathname = decodeURIComponent(rawUrl.split(/[?#]/, 1)[0] ?? '');
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  const target = resolve(root, `.${pathname}`);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

async function statOrNull(path) {
  try {
    return await promises.stat(path);
  } catch {
    return null;
  }
}

function reply(res, status, message) {
  res.writeHead(status, { ...PRIVACY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`${message}\n`);
}

async function handle(root, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return reply(res, 405, 'Method not allowed');
  }
  let file = resolveInside(root, req.url ?? '');
  let info = file && (await statOrNull(file));
  if (file && info?.isDirectory()) {
    file = join(file, 'index.html');
    info = await statOrNull(file);
  }
  if (!file || !info?.isFile()) return reply(res, 404, 'Not found');
  res.writeHead(200, {
    ...PRIVACY_HEADERS,
    'Content-Type': MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': info.size,
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
}

export function startServer({ root, port }) {
  const base = resolve(root);
  const server = createServer((req, res) => {
    handle(base, req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else reply(res, 500, 'Server error');
    });
  });
  return new Promise((done, fail) => {
    const onError = (error) => {
      fail(
        error.code === 'EADDRINUSE'
          ? new Error(
              `Port ${port} is already in use. Pick another with --port <number>, or use --port 0 for a free one.`,
            )
          : error,
      );
    };
    server.once('error', onError);
    server.listen(port, HOST, () => {
      server.off('error', onError);
      const address = server.address();
      done({ server, url: `http://localhost:${address.port}/` });
    });
  });
}

function openBrowser(url) {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => console.log(`Could not open a browser. Open ${url} yourself.`));
  child.unref();
}

async function main() {
  if (process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h')) {
    console.log(
      'Usage: deerdiary [--port <0-65535>] [--no-open]\nServes the built app on localhost. --port 0 picks a free port.',
    );
    return;
  }
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const tooOld = nodeVersionError(process.versions.node, manifest.engines.node);
  if (tooOld) throw new Error(tooOld);
  const options = parseArgs(process.argv.slice(2));
  const root = fileURLToPath(new URL('../dist/', import.meta.url));
  if (!(await statOrNull(root))?.isDirectory()) {
    throw new Error(`No built app at ${root}. Run "npm run build" first.`);
  }
  const { url } = await startServer({ root, port: options.port });
  console.log(`deerdiary is running at ${url}`);
  if (options.open) openBrowser(url);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
