import type { CamtrapDpInput, CamtrapDpLocation } from './camtrapDp';

export const SAMPLING_DESIGNS = [
  { value: 'simpleRandom', label: 'Simple random' },
  { value: 'systematicRandom', label: 'Systematic random' },
  { value: 'clusteredRandom', label: 'Clustered random' },
  { value: 'experimental', label: 'Experimental' },
  { value: 'targeted', label: 'Targeted' },
  { value: 'opportunistic', label: 'Opportunistic' },
] as const;

export type CamtrapDraft = {
  projectTitle: string;
  contributor: string;
  samplingDesign: string;
  individualAnimals: boolean;
  locations: Record<string, { latitude: string; longitude: string }>;
};
export type CamtrapMetadata = Required<
  Pick<CamtrapDpInput, 'locations' | 'project' | 'contributors'>
>;

export function emptyCamtrapDraft(cameras: readonly string[]): CamtrapDraft {
  return {
    projectTitle: '',
    contributor: '',
    samplingDesign: '',
    individualAnimals: false,
    locations: Object.fromEntries(cameras.map((id) => [id, { latitude: '', longitude: '' }])),
  };
}

/** Converts user-entered decimal coordinates only after reporting every invalid field. */
export function validateCamtrapDraft(
  draft: CamtrapDraft,
  cameras: readonly string[],
): { ok: true; metadata: CamtrapMetadata } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!draft.projectTitle.trim()) errors.projectTitle = 'Enter a project title.';
  if (!draft.contributor.trim()) errors.contributor = 'Enter a contributor name.';
  const samplingDesign = SAMPLING_DESIGNS.find(
    ({ value }) => value === draft.samplingDesign,
  )?.value;
  if (samplingDesign === undefined) errors.samplingDesign = 'Choose the project sampling design.';
  const locations: Record<string, CamtrapDpLocation> = {};
  for (const camera of cameras) {
    const coordinates = draft.locations[camera];
    const latitude = coordinates?.latitude.trim() ?? '';
    const longitude = coordinates?.longitude.trim() ?? '';
    const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
    if (
      !decimal.test(latitude) ||
      !Number.isFinite(Number(latitude)) ||
      Math.abs(Number(latitude)) > 90
    ) {
      errors[`latitude:${camera}`] = 'Enter a latitude from -90 to 90.';
    }
    if (
      !decimal.test(longitude) ||
      !Number.isFinite(Number(longitude)) ||
      Math.abs(Number(longitude)) > 180
    ) {
      errors[`longitude:${camera}`] = 'Enter a longitude from -180 to 180.';
    }
    locations[camera] = { latitude: Number(latitude), longitude: Number(longitude) };
  }
  if (Object.keys(errors).length > 0 || samplingDesign === undefined) return { ok: false, errors };
  return {
    ok: true,
    metadata: {
      locations,
      project: {
        title: draft.projectTitle.trim(),
        samplingDesign,
        individualAnimals: draft.individualAnimals,
      },
      contributors: [{ title: draft.contributor.trim() }],
    },
  };
}

/** Checks the shape of a saved draft without requiring its unfinished fields to be valid. */
export function isCamtrapDraft(value: unknown): value is CamtrapDraft {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (
    !('projectTitle' in value) ||
    typeof value.projectTitle !== 'string' ||
    !('contributor' in value) ||
    typeof value.contributor !== 'string' ||
    !('samplingDesign' in value) ||
    typeof value.samplingDesign !== 'string' ||
    !('individualAnimals' in value) ||
    typeof value.individualAnimals !== 'boolean' ||
    !('locations' in value) ||
    typeof value.locations !== 'object' ||
    value.locations === null ||
    Array.isArray(value.locations)
  )
    return false;
  return Object.values(value.locations).every(
    (coordinate: unknown) =>
      typeof coordinate === 'object' &&
      coordinate !== null &&
      'latitude' in coordinate &&
      typeof coordinate.latitude === 'string' &&
      'longitude' in coordinate &&
      typeof coordinate.longitude === 'string',
  );
}
