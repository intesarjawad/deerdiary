import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, get, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { COEP, COOP, CSP } from '../../bin/headers.mjs';
import { nodeVersionError, parseArgs, startServer } from '../../bin/serve.mjs';

type Reply = { status: number; headers: IncomingHttpHeaders; body: Buffer };

let workspace = '';
let url = '';
let stop = async () => {};

function request(path: string, method = 'GET'): Promise<Reply> {
  const { port } = new URL(url);
  return new Promise((done, fail) => {
    get({ host: '127.0.0.1', port, path, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    }).on('error', fail);
  });
}

function expectPrivacyHeaders(reply: Reply) {
  expect(reply.headers['content-security-policy']).toBe(CSP);
  expect(reply.headers['cross-origin-opener-policy']).toBe(COOP);
  expect(reply.headers['cross-origin-embedder-policy']).toBe(COEP);
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'deerdiary-serve-'));
  const dist = join(workspace, 'dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(workspace, 'package.json'), '{"name":"outside"}');
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>diary</title>');
  await writeFile(join(dist, 'assets', 'app.js'), 'export const a = 1;');
  await writeFile(join(dist, 'assets', 'worker.mjs'), 'export const b = 2;');
  await writeFile(join(dist, 'runtime.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
  const started = await startServer({ root: dist, port: 0 });
  url = started.url;
  stop = () => new Promise((done) => started.server.close(() => done(undefined)));
});

afterAll(async () => {
  await stop();
  await rm(workspace, { recursive: true, force: true });
});

test('picks a free port when asked for port 0', () => {
  expect(new URL(url).port).not.toBe('0');
  expect(url).toMatch(/^http:\/\/localhost:\d+\/$/);
});

test('answers / with index.html and adds the three headers', async () => {
  const reply = await request('/');
  expect(reply.status).toBe(200);
  expect(reply.headers['content-type']).toBe('text/html; charset=utf-8');
  expect(reply.body.toString()).toBe('<!doctype html><title>diary</title>');
  expectPrivacyHeaders(reply);
});

test('adds the three headers to JavaScript and WASM responses with the right types', async () => {
  const script = await request('/assets/app.js');
  expect(script.status).toBe(200);
  expect(script.headers['content-type']).toBe('text/javascript');
  expectPrivacyHeaders(script);

  const module = await request('/assets/worker.mjs');
  expect(module.headers['content-type']).toBe('text/javascript');
  expectPrivacyHeaders(module);

  const wasm = await request('/runtime.wasm');
  expect(wasm.status).toBe(200);
  expect(wasm.headers['content-type']).toBe('application/wasm');
  expect(wasm.headers['content-length']).toBe('8');
  expectPrivacyHeaders(wasm);
});

test('answers HEAD with the headers and no body', async () => {
  const reply = await request('/', 'HEAD');
  expect(reply.status).toBe(200);
  expect(reply.body.length).toBe(0);
  expectPrivacyHeaders(reply);
});

test('answers 404 with the headers for a missing file', async () => {
  const reply = await request('/missing.js');
  expect(reply.status).toBe(404);
  expectPrivacyHeaders(reply);
});

test('answers 404 for paths that resolve outside dist, even when the file exists', async () => {
  for (const path of [
    '/../package.json',
    '/%2e%2e/package.json',
    '/%2E%2E%2Fpackage.json',
    '/assets/../../package.json',
    '/..%5Cpackage.json',
    '/%00',
    '/%zz',
  ]) {
    const reply = await request(path);
    expect(reply.status, path).toBe(404);
    expect(reply.body.toString(), path).not.toContain('outside');
    expectPrivacyHeaders(reply);
  }
});

test('refuses methods other than GET and HEAD', async () => {
  const reply = await request('/', 'POST');
  expect(reply.status).toBe(405);
  expect(reply.headers.allow).toBe('GET, HEAD');
  expectPrivacyHeaders(reply);
});

test('names the busy port and the way out when the port is taken', async () => {
  const blocker = createServer();
  await new Promise<void>((done) => blocker.listen(0, '127.0.0.1', () => done()));
  const address = blocker.address();
  if (typeof address !== 'object' || address === null) throw new Error('No port bound');
  try {
    await expect(startServer({ root: workspace, port: address.port })).rejects.toThrow(
      `Port ${address.port} is already in use. Pick another with --port <number>, or use --port 0 for a free one.`,
    );
  } finally {
    await new Promise((done) => blocker.close(done));
  }
});

test('reads --port and --no-open', () => {
  expect(parseArgs([])).toEqual({ port: 4321, open: true });
  expect(parseArgs(['--port', '0', '--no-open'])).toEqual({ port: 0, open: false });
  expect(parseArgs(['--port=8080'])).toEqual({ port: 8080, open: true });
});

test('rejects unusable arguments', () => {
  expect(() => parseArgs(['--port'])).toThrow('--port needs a whole number from 0 to 65535');
  expect(() => parseArgs(['--port', '70000'])).toThrow('from 0 to 65535, not "70000"');
  expect(() => parseArgs(['--port', 'abc'])).toThrow('not "abc"');
  expect(() => parseArgs(['--verbose'])).toThrow('Unknown option "--verbose"');
});

test('reports an older Node and accepts a current one', () => {
  expect(nodeVersionError('20.11.1', '>=22')).toBe(
    'deerdiary needs Node 22 or newer, but this is Node 20.11.1. Install a current Node from https://nodejs.org/ and run it again.',
  );
  expect(nodeVersionError('22.0.0', '>=22')).toBeNull();
  expect(nodeVersionError('26.1.0', '>=22')).toBeNull();
  expect(nodeVersionError('22.3.0', '>=22.4.0')).not.toBeNull();
  expect(nodeVersionError('22.4.0', '>=22.4.0')).toBeNull();
});

test('CLI help exits successfully without starting a server', () => {
  const result = spawnSync(process.execPath, ['bin/serve.mjs', '--help'], {
    encoding: 'utf8',
    timeout: 2000,
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Usage: deerdiary');
  expect(result.stdout).toContain('--port');
  expect(result.stdout).toContain('--no-open');
});
