import { expect, test } from 'vitest';
import { sampleOriginalURL } from '../../src/app/sample';

const base = 'https://example.test/deerdiary/';

test('a user folder named sample never gets the bundled sample originals', () => {
  expect(sampleOriginalURL('sample/IMG_0001.jpg', false, base)).toBeUndefined();
});

test('the bundled sample resolves its originals only once it is shown', () => {
  expect(sampleOriginalURL('sample/IMG_0001.jpg', true, base)).toBe(
    'https://example.test/deerdiary/sample/IMG_0001.jpg',
  );
  expect(sampleOriginalURL('other/IMG_0001.jpg', true, base)).toBeUndefined();
});
