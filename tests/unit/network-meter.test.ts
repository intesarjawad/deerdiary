import { expect, test } from 'vitest';
import {
  createNetworkMeter,
  formatNetworkMeter,
  isResourceMessage,
  resourceRecord,
} from '../../src/app/networkMeter';

const model = 'https://huggingface.co/repo/resolve/revision/model.onnx';
const cdn = 'https://us.aws.cdn.hf.co/model';

test('counts repeated model and other requests across page and worker timelines from the drop', () => {
  const meter = createNetworkMeter([model, cdn]);
  const record = { url: model, startedAt: 100, encodedBodyBytes: 500_000 };
  meter.record([record]);
  expect(formatNetworkMeter(meter.snapshot())).toBe('0 requests');
  meter.start(100);
  meter.record([{ ...record, startedAt: 99 }, record, record]);
  meter.record([
    { url: cdn, startedAt: 101, encodedBodyBytes: 1_000_000 },
    { url: 'https://local.test/worker.js', startedAt: 102, encodedBodyBytes: 10 },
    { url: 'https://unexpected.test/attempt', startedAt: 103, encodedBodyBytes: null },
  ]);
  expect(meter.snapshot()).toEqual({
    modelRequests: 3,
    modelBytes: 2_000_000,
    unknownModelSizes: 0,
    otherRequests: 2,
    hosts: { 'local.test': 1, 'unexpected.test': 1 },
  });
  expect(formatNetworkMeter(meter.snapshot())).toBe(
    'model download: 3 files, 2.00 MB from huggingface.co; local.test: 1 requests; unexpected.test: 1 requests',
  );
  meter.start(200);
  meter.record([{ ...record, startedAt: 199 }]);
  expect(formatNetworkMeter(meter.snapshot())).toBe('0 requests');
});

test('never reports zero when there are models, unknown hosts or concealed byte counts', () => {
  const meter = createNetworkMeter([model]);
  meter.start(0);
  meter.record([{ url: model, startedAt: 1, encodedBodyBytes: null }]);
  expect(formatNetworkMeter(meter.snapshot())).toBe(
    'model download: 1 files, size unavailable from huggingface.co',
  );
  meter.start(0);
  meter.record([{ url: cdn, startedAt: 1, encodedBodyBytes: null }]);
  expect(formatNetworkMeter(meter.snapshot())).toBe('us.aws.cdn.hf.co: 1 requests');
});

test('validates worker resource messages without confusing application messages', () => {
  const valid = {
    kind: 'network-resources',
    resources: [{ url: model, startedAt: 1, encodedBodyBytes: null }],
  };
  expect(isResourceMessage(valid)).toBe(true);
  for (const value of [
    null,
    {},
    { kind: 'ready' },
    { ...valid, resources: [{}] },
    {
      ...valid,
      resources: [{ url: 'bad url', startedAt: 1, encodedBodyBytes: 0 }],
    },
    { ...valid, resources: [{ url: model, startedAt: Number.NaN, encodedBodyBytes: -1 }] },
  ]) {
    expect(isResourceMessage(value)).toBe(false);
  }
});

test('aligns independent time origins and preserves hidden sizes instead of reporting zero bytes', () => {
  const pageEntry = resourceRecord({ name: model, startTime: 90, encodedBodySize: 20 }, 1000);
  const workerEntry = resourceRecord({ name: model, startTime: 40, encodedBodySize: 0 }, 1050);
  expect(pageEntry.startedAt).toBe(workerEntry.startedAt);
  expect(pageEntry.encodedBodyBytes).toBe(20);
  expect(workerEntry.encodedBodyBytes).toBeNull();
  const meter = createNetworkMeter([model]);
  meter.start(1090);
  meter.record([pageEntry, workerEntry]);
  expect(meter.snapshot().modelRequests).toBe(2);
  expect(meter.snapshot().unknownModelSizes).toBe(1);
});
