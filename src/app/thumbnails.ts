import type { StoredResult } from '../storage/schema';

export type ThumbnailBlobs = ReadonlyMap<string, Blob>;

/** Keeps one preview per processed photo; a failed decode has none to show. */
export function thumbnailBlobs(results: readonly StoredResult[]): ThumbnailBlobs {
  const blobs = new Map<string, Blob>();
  for (const { output } of results) {
    if (output.status === 'ok' && output.thumbnail.size > 0)
      blobs.set(output.path, output.thumbnail);
  }
  return blobs;
}

export type ThumbnailURLs = {
  update(results: readonly StoredResult[]): void;
  url(path: string): string | undefined;
  revokeAll(): void;
};

/** Creates each preview URL once and revokes it when the stored results change. */
export function createThumbnailURLs(
  create: (blob: Blob) => string = (blob) => URL.createObjectURL(blob),
  revoke: (url: string) => void = (url) => URL.revokeObjectURL(url),
): ThumbnailURLs {
  let blobs: ThumbnailBlobs = new Map();
  const urls = new Map<string, string>();

  function revokeAll() {
    for (const url of urls.values()) revoke(url);
    urls.clear();
  }

  return {
    update(results) {
      revokeAll();
      blobs = thumbnailBlobs(results);
    },
    url(path) {
      const blob = blobs.get(path);
      if (blob === undefined) return undefined;
      const existing = urls.get(path);
      if (existing !== undefined) return existing;
      const created = create(blob);
      urls.set(path, created);
      return created;
    },
    revokeAll,
  };
}
