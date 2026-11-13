import type { ComponentChildren } from 'preact';
import { expect, test } from 'vitest';
import { Footer } from '../../src/ui/Footer';

function text(node: ComponentChildren): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((child) => text(child)).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    return text((node.props as { children?: ComponentChildren }).children);
  }
  return '';
}

test('totals use singular and plural labels', () => {
  const one = text(
    Footer({ photoCount: 1, speciesCount: 0, blankPhotos: 1, humanPhotos: 1, vehiclePhotos: 1 }),
  );
  const many = text(
    Footer({ photoCount: 2, speciesCount: 1, blankPhotos: 2, humanPhotos: 3, vehiclePhotos: 4 }),
  );

  expect(one).toContain('1 photo · 0 species · 1 blank photo · 1 person · 1 vehicle');
  expect(many).toContain('2 photos · 1 species · 2 blank photos · 3 people · 4 vehicles');
});

test('an empty network meter keeps the footer truthful before the first drop', () => {
  expect(text(Footer({ photoCount: 0, speciesCount: 0 }))).toContain(
    '0 requests since you dropped the folder',
  );
});

test('a network snapshot is summarised with its host counts', () => {
  const summary = text(
    Footer({
      photoCount: 1,
      speciesCount: 1,
      network: {
        modelRequests: 1,
        modelBytes: 2_500_000,
        unknownModelSizes: 0,
        otherRequests: 1,
        hosts: { 'example.com': 1 },
      },
      sourceHref: 'https://example.com/source',
    }),
  );

  expect(summary).toContain(
    'Requests since you dropped the folder: model download: 1 files, 2.50 MB from huggingface.co; example.com: 1 requests',
  );
  expect(summary).toContain('Source on GitHub');
});
