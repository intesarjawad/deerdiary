import { createHash } from 'node:crypto';
import type { ModelFile } from '../../src/app/models';

export const syntheticModels = [
  { role: 'detector', body: 'synthetic detector model\n' },
  { role: 'detector_reference', body: 'synthetic reference detector model\n' },
  { role: 'classifier', body: 'synthetic classifier model\n' },
  { role: 'classifier_labels', body: 'synthetic classifier labels\n' },
  { role: 'taxonomy', body: 'synthetic taxonomy\n' },
  { role: 'geofence', body: 'synthetic geofence\n' },
  { role: 'perch', body: 'synthetic audio model\n' },
  { role: 'perch_labels', body: 'synthetic audio labels\n' },
] as const;

export function syntheticModelManifest(baseURL: string): ModelFile[] {
  return syntheticModels.map(({ role, body }) => ({
    role,
    url: new URL(role, baseURL).href,
    bytes: Buffer.byteLength(body),
    sha256: createHash('sha256').update(body).digest('hex'),
  }));
}
