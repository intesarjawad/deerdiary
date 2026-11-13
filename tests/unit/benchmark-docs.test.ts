import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

test.each(['coldstart', 'bench'])(
  'check mode rejects a stale %s block without writing',
  async (block) => {
    const directory = await mkdtemp(join(tmpdir(), 'deerdiary-docs-'));
    try {
      await symlink(resolve('tools'), join(directory, 'tools'));
      await symlink(resolve('node_modules'), join(directory, 'node_modules'));
      await cp('package.json', join(directory, 'package.json'));
      await mkdir(join(directory, 'docs'));
      const original = await readFile('docs/benchmarks.md', 'utf8');
      const marker = block === 'coldstart' ? 'coldstart:results' : 'bench:results';
      const stale = original.replace(
        new RegExp(`(<!-- ${marker} -->)[\\s\\S]*?(<!-- /${marker} -->)`),
        '$1\nstale\n$2',
      );
      expect(stale).not.toBe(original);
      const target = join(directory, 'docs/benchmarks.md');
      await writeFile(target, stale);
      let output = '';
      try {
        execFileSync('npm', ['run', 'docs:bench', '--', '--check'], {
          cwd: directory,
          stdio: 'pipe',
        });
      } catch (cause) {
        if (cause instanceof Error && 'stderr' in cause) output = String(cause.stderr);
      }
      expect(output).toContain('out of date');
      expect(await readFile(target, 'utf8')).toBe(stale);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
