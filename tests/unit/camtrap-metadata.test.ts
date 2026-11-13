import { expect, test } from 'vitest';
import { emptyCamtrapDraft, validateCamtrapDraft } from '../../src/core/camtrapMetadata';

function draft() {
  return {
    ...emptyCamtrapDraft(['cam/a', 'cam/b']),
    projectTitle: 'Survey',
    contributor: 'Researcher',
    samplingDesign: 'systematicRandom',
    locations: {
      'cam/a': { latitude: '-90', longitude: '180' },
      'cam/b': { latitude: '0', longitude: '0' },
    },
  };
}

test('accepts boundary and zero coordinates for every deployment without changing the draft', () => {
  const input = draft();
  const before = structuredClone(input);
  const result = validateCamtrapDraft(input, ['cam/a', 'cam/b']);
  expect(result).toEqual({
    ok: true,
    metadata: {
      locations: {
        'cam/a': { latitude: -90, longitude: 180 },
        'cam/b': { latitude: 0, longitude: 0 },
      },
      project: { title: 'Survey', samplingDesign: 'systematicRandom', individualAnimals: false },
      contributors: [{ title: 'Researcher' }],
    },
  });
  expect(input).toEqual(before);
});

test.each(['', ' ', 'NaN', 'Infinity', '91', '-90.1', '0x20'])(
  'rejects invalid latitude %j inline',
  (latitude) => {
    const input = draft();
    input.locations['cam/a'].latitude = latitude;
    const result = validateCamtrapDraft(input, ['cam/a', 'cam/b']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors['latitude:cam/a']).toMatch(/-90.*90/);
  },
);

test.each(['', '-180.1', '181', 'Infinity'])('rejects invalid longitude %j inline', (longitude) => {
  const input = draft();
  input.locations['cam/b'].longitude = longitude;
  const result = validateCamtrapDraft(input, ['cam/a', 'cam/b']);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.errors['longitude:cam/b']).toMatch(/-180.*180/);
});

test('requires project, contributor and sampling design and identifies a newly added camera', () => {
  const input = emptyCamtrapDraft(['cam/a']);
  const result = validateCamtrapDraft(input, ['cam/a', 'cam/b']);
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(Object.keys(result.errors)).toEqual([
      'projectTitle',
      'contributor',
      'samplingDesign',
      'latitude:cam/a',
      'longitude:cam/a',
      'latitude:cam/b',
      'longitude:cam/b',
    ]);
});
