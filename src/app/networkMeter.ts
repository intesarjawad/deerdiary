export type ResourceRecord = {
  url: string;
  startedAt: number;
  encodedBodyBytes: number | null;
};

export type NetworkSnapshot = {
  modelRequests: number;
  modelBytes: number;
  unknownModelSizes: number;
  otherRequests: number;
  hosts: Record<string, number>;
};

export type ResourceMessage = { kind: 'network-resources'; resources: ResourceRecord[] };

export function isResourceMessage(value: unknown): value is ResourceMessage {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false;
  if (value.kind !== 'network-resources' || !('resources' in value)) return false;
  return (
    Array.isArray(value.resources) &&
    value.resources.every((record: unknown) => {
      if (typeof record !== 'object' || record === null) return false;
      return (
        'url' in record &&
        typeof record.url === 'string' &&
        URL.canParse(record.url) &&
        'startedAt' in record &&
        typeof record.startedAt === 'number' &&
        Number.isFinite(record.startedAt) &&
        'encodedBodyBytes' in record &&
        (record.encodedBodyBytes === null ||
          (typeof record.encodedBodyBytes === 'number' &&
            Number.isFinite(record.encodedBodyBytes) &&
            record.encodedBodyBytes >= 0))
      );
    })
  );
}

export function resourceRecord(
  entry: Pick<PerformanceResourceTiming, 'name' | 'startTime' | 'encodedBodySize'>,
  timeOrigin: number,
): ResourceRecord {
  return {
    url: entry.name,
    startedAt: timeOrigin + entry.startTime,
    // Without Timing-Allow-Origin, a cross-origin resource conceals its byte counts.
    encodedBodyBytes: entry.encodedBodySize > 0 ? entry.encodedBodySize : null,
  };
}

/** Each page and worker owns a separate resource timeline. Absolute times align them. */
export function observeResources(report: (resources: ResourceRecord[]) => void): () => void {
  const observer = new PerformanceObserver((list) => {
    report(
      list.getEntries().flatMap((entry) => {
        if (!(entry instanceof PerformanceResourceTiming)) return [];
        return [resourceRecord(entry, performance.timeOrigin)];
      }),
    );
  });
  observer.observe({ type: 'resource', buffered: true });
  return () => observer.disconnect();
}

export function createNetworkMeter(modelURLs: readonly string[] = []) {
  const models = new Set(modelURLs);
  let startedAt = Number.POSITIVE_INFINITY;
  let records: ResourceRecord[] = [];
  return {
    start(dropTime = performance.timeOrigin + performance.now()) {
      startedAt = dropTime;
      records = [];
    },
    record(resources: readonly ResourceRecord[]) {
      records.push(...resources.filter((record) => record.startedAt >= startedAt));
    },
    snapshot(): NetworkSnapshot {
      const result: NetworkSnapshot = {
        modelRequests: 0,
        modelBytes: 0,
        unknownModelSizes: 0,
        otherRequests: 0,
        hosts: {},
      };
      for (const record of records) {
        if (models.has(record.url)) {
          result.modelRequests++;
          if (record.encodedBodyBytes === null) result.unknownModelSizes++;
          else result.modelBytes += record.encodedBodyBytes;
        } else {
          result.otherRequests++;
          const url = new URL(record.url);
          const host = url.host || url.protocol;
          result.hosts[host] = (result.hosts[host] ?? 0) + 1;
        }
      }
      return result;
    },
  };
}

export type NetworkMeter = ReturnType<typeof createNetworkMeter>;

export function formatNetworkMeter(snapshot: NetworkSnapshot): string {
  if (snapshot.modelRequests === 0 && snapshot.otherRequests === 0) return '0 requests';
  const lines: string[] = [];
  if (snapshot.modelRequests > 0) {
    const size =
      snapshot.unknownModelSizes > 0
        ? 'size unavailable'
        : `${(snapshot.modelBytes / 1_000_000).toFixed(2)} MB`;
    lines.push(`model download: ${snapshot.modelRequests} files, ${size} from huggingface.co`);
  }
  for (const [host, count] of Object.entries(snapshot.hosts).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    lines.push(`${host}: ${count} requests`);
  }
  return lines.join('; ');
}
