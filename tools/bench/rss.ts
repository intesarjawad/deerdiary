import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runPs = promisify(execFile);

// ps reports resident set size in 1024-byte blocks on macOS and Linux.
const PS_BLOCK_BYTES = 1024;

export type ProcessRss = { pid: number; ppid: number; rssBytes: number };

export type RssPoint = { photos: number; rssBytes: number };

function field(value: string | undefined, label: string, line: string): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new Error(`Unexpected ${label} in ps row: ${line}`);
  }
  return Number(value);
}

/** Reads the fixed `ps -A -o pid=,ppid=,rss=` column layout. */
export function parsePs(output: string): ProcessRss[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const fields = line.trim().split(/\s+/);
      if (fields.length !== 3) throw new Error(`Unexpected ps row: ${line}`);
      return {
        pid: field(fields[0], 'pid', line),
        ppid: field(fields[1], 'ppid', line),
        rssBytes: field(fields[2], 'rss', line) * PS_BLOCK_BYTES,
      };
    });
}

/** Collects a process and every descendant, including children of children. */
export function processTree(rootPid: number, processes: readonly ProcessRss[]): ProcessRss[] {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const children = new Map<number, number[]>();
  for (const process of processes) {
    const siblings = children.get(process.ppid) ?? [];
    siblings.push(process.pid);
    children.set(process.ppid, siblings);
  }
  const tree: ProcessRss[] = [];
  const seen = new Set<number>();
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    const process = byPid.get(pid);
    if (process === undefined) continue;
    tree.push(process);
    queue.push(...(children.get(pid) ?? []));
  }
  return tree;
}

/** Sums a browser tree, so renderer, GPU and utility processes count against peak memory. */
export function treeRssBytes(rootPid: number, processes: readonly ProcessRss[]): number {
  return processTree(rootPid, processes).reduce((total, process) => total + process.rssBytes, 0);
}

export function peakRssBytes(points: readonly RssPoint[]): number {
  return points.reduce((peak, point) => Math.max(peak, point.rssBytes), 0);
}

/**
 * Fits bytes per photo to samples taken once the allocator has settled; a cold-start spike before
 * the warm-up would otherwise look like unbounded growth.
 */
export function rssSlopeBytesPerPhoto(
  points: readonly RssPoint[],
  afterPhotos: number,
): number | null {
  const samples = points.filter((point) => point.photos >= afterPhotos);
  if (samples.length < 2) return null;
  const meanX = samples.reduce((total, point) => total + point.photos, 0) / samples.length;
  const meanY = samples.reduce((total, point) => total + point.rssBytes, 0) / samples.length;
  let covariance = 0;
  let variance = 0;
  for (const point of samples) {
    covariance += (point.photos - meanX) * (point.rssBytes - meanY);
    variance += (point.photos - meanX) ** 2;
  }
  return variance === 0 ? null : covariance / variance;
}

/** Reads one whole-tree sample with the same ps invocation the benchmark repeats each second. */
export async function readTreeRss(rootPid: number): Promise<number> {
  const { stdout } = await runPs('ps', ['-A', '-o', 'pid=,ppid=,rss=']);
  return treeRssBytes(rootPid, parsePs(stdout));
}
