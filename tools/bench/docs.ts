import { execFileSync } from 'node:child_process';

for (const script of ['tools/coldstart/coldstart.ts', 'tools/bench/bench_photos.ts']) {
  execFileSync(process.execPath, ['--import', 'tsx', script, 'docs', ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
}
