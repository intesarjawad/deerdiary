import { expect, test } from 'vitest';
import {
  parsePs,
  peakRssBytes,
  processTree,
  rssSlopeBytesPerPhoto,
  treeRssBytes,
} from '../../tools/bench/rss';

// pid, parent and RSS in 1024-byte blocks, as `ps -A -o pid=,ppid=,rss=` prints them.
const PS = `  100     1  2048
  101   100  1024
  102   101   512
  103   100  4096
  200     1  8192
`;

test('reads the fixed ps columns and converts blocks to bytes', () => {
  expect(parsePs(PS)).toEqual([
    { pid: 100, ppid: 1, rssBytes: 2_097_152 },
    { pid: 101, ppid: 100, rssBytes: 1_048_576 },
    { pid: 102, ppid: 101, rssBytes: 524_288 },
    { pid: 103, ppid: 100, rssBytes: 4_194_304 },
    { pid: 200, ppid: 1, rssBytes: 8_388_608 },
  ]);
  expect(() => parsePs('  100     1')).toThrow('Unexpected ps row');
});

test('sums a whole descendant tree and excludes siblings of the browser root', () => {
  const processes = parsePs(PS);
  expect(processTree(100, processes).map((process) => process.pid)).toEqual([100, 101, 103, 102]);
  expect(treeRssBytes(100, processes)).toBe(7_864_320);
  expect(treeRssBytes(999, processes)).toBe(0);
});

test('fits the settled memory slope and ignores the warm-up samples', () => {
  expect(
    rssSlopeBytesPerPhoto(
      [
        { photos: 1_000, rssBytes: 900_000 },
        { photos: 2_000, rssBytes: 2_000_000 },
        { photos: 3_000, rssBytes: 4_000_000 },
        { photos: 4_000, rssBytes: 6_000_000 },
      ],
      2_000,
    ),
  ).toBe(2_000);
  expect(rssSlopeBytesPerPhoto([{ photos: 2_500, rssBytes: 1 }], 2_000)).toBeNull();
  expect(
    peakRssBytes([
      { photos: 1, rssBytes: 10 },
      { photos: 2, rssBytes: 30 },
    ]),
  ).toBe(30);
});
