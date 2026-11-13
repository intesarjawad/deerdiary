import type { DBSchema } from 'idb';
import type { CamtrapDraft } from '../core/camtrapMetadata';
import type { CameraTime } from '../core/time';
import type { PhotoResult } from '../workers/photo';

export type FileRecord = {
  key: string;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
};
export type StoredResult = { key: string; time: CameraTime; output: PhotoResult };
export type Session = {
  id: string;
  createdAtMs: number;
  fileKeys: string[];
  camtrap?: CamtrapDraft;
  dateRange: { first: number; last: number } | null;
};
export type Location = { country?: string; admin1Region?: string };
export type StorageBatch = {
  files: readonly FileRecord[];
  results: readonly StoredResult[];
  session: Session;
};

/** Identifies an unchanged file without retaining its contents. */
export function fileKey(file: Omit<FileRecord, 'key'>): string {
  return `${file.path}|${file.sizeBytes}|${file.mtimeMs}`;
}

export interface PhotoDatabase extends DBSchema {
  files: { key: string; value: FileRecord };
  results: { key: string; value: StoredResult };
  corrections: { key: string; value: string };
  sessions: { key: string; value: Session };
  settings: { key: string; value: Location };
}

export interface PipelineStorage {
  readonly memoryOnly: boolean;
  loadResults(keys: readonly string[]): Promise<StoredResult[]>;
  saveBatch(batch: StorageBatch): Promise<void>;
  loadLocation(): Promise<Location | undefined>;
  saveLocation(location: Location): Promise<void>;
}
