import * as ort from 'onnxruntime-web/webgpu';
import { agreement, type Predictions, percentile } from './detector-metrics';

type Asset = { url: string; sha256: string; bytes: number };
type Fixture = Asset & {
  name: string;
  size: [number, number];
  expected: Predictions;
  sorrel?: Asset;
};
type Configuration = {
  models: (Asset & { id: string; kind: 'rtdetr' | 'sorrel' })[];
  cases: Fixture[];
  reference: unknown;
};

function element<T extends HTMLElement>(id: string, kind: { new (): T }): T {
  const value = document.getElementById(id);
  if (!(value instanceof kind)) throw new Error(`Missing ${id}`);
  return value;
}
const status = element('status', HTMLParagraphElement);
const output = element('result', HTMLPreElement);
const download = element('download', HTMLAnchorElement);
const form = element('controls', HTMLFormElement);
let reportUrl: string | undefined;

async function verified(asset: Asset): Promise<ArrayBuffer> {
  const response = await fetch(`/data/${asset.url}`);
  if (!response.ok) throw new Error(`Cannot load ${asset.url}: HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
  if (bytes.byteLength !== asset.bytes || digest !== asset.sha256) {
    throw new Error(`Integrity mismatch: ${asset.url}`);
  }
  return bytes;
}

function predictions(values: ort.InferenceSession.ReturnType): Predictions {
  const { labels, boxes, scores } = values;
  if (
    !labels ||
    !boxes ||
    !scores ||
    labels.type !== 'int64' ||
    boxes.type !== 'float32' ||
    scores.type !== 'float32' ||
    labels.dims.join(',') !== '1,300' ||
    boxes.dims.join(',') !== '1,300,4' ||
    scores.dims.join(',') !== '1,300'
  ) {
    throw new Error('Unexpected RT-DETR output names, shapes or types');
  }
  return {
    labels: Array.from(labels.data, Number),
    boxes: Array.from(boxes.data, Number),
    scores: Array.from(scores.data, Number),
  };
}

async function run() {
  const count = element('count', HTMLInputElement).valueAsNumber;
  const backend = element('backend', HTMLSelectElement).value;
  if (!Number.isInteger(count) || count < 1 || count > 10000)
    throw new Error('Use 1 to 10000 inferences');
  if (backend !== 'webgpu' && backend !== 'wasm') throw new Error('Unknown provider');
  if (backend === 'webgpu' && !navigator.gpu) throw new Error('WebGPU unavailable; select WASM');
  ort.env.wasm.wasmPaths = '/ort/';
  const response = await fetch('/data/fixtures.json');
  if (!response.ok) throw new Error('Prepare fixtures before serving the benchmark');
  const configuration: Configuration = await response.json();
  if (!configuration.models.length || !configuration.cases.length)
    throw new Error('Empty fixture configuration');
  const fixtures = await Promise.all(
    configuration.cases.map(async (fixture) => ({
      ...fixture,
      images: new ort.Tensor(
        'float32',
        new Float32Array(await verified(fixture)),
        [1, 3, 640, 640],
      ),
      sorrelImages: fixture.sorrel
        ? new ort.Tensor(
            'float32',
            new Float32Array(await verified(fixture.sorrel)),
            [1, 3, 960, 960],
          )
        : undefined,
      sizes: new ort.Tensor('int64', BigInt64Array.from(fixture.size, BigInt), [1, 2]),
    })),
  );
  const results: object[] = [];
  const firstOutputs = new Map<string, Predictions>();
  try {
    for (const model of configuration.models) {
      status.textContent = `Loading ${model.id}`;
      let session: ort.InferenceSession | undefined;
      try {
        session = await ort.InferenceSession.create(await verified(model), {
          executionProviders: backend === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'],
        });
        const comparisons: object[] = [];
        const modelFixtures = fixtures.map((fixture) => {
          let feeds: ort.InferenceSession.FeedsType;
          if (model.kind === 'sorrel') {
            if (!fixture.sorrelImages)
              throw new Error('Prepare sorrel tensors before measuring sorrel');
            feeds = { images: fixture.sorrelImages };
          } else {
            feeds = { images: fixture.images, orig_target_sizes: fixture.sizes };
          }
          return { ...fixture, feeds };
        });
        for (const fixture of modelFixtures) {
          status.textContent = `${model.id}: warm-up and agreement on ${fixture.name}`;
          const values = await session.run(fixture.feeds);
          try {
            if (model.kind === 'sorrel') {
              const rows = values.output0;
              if (rows?.type !== 'float32' || rows.dims.join(',') !== '1,300,6') {
                throw new Error('Unexpected sorrel output names, shapes or types');
              }
              comparisons.push({
                case: fixture.name,
                shapes: { output0: rows.dims },
                agreement: 'Different architecture; no numeric equivalence asserted',
              });
              continue;
            }
            const actual = predictions(values);
            const baseline = firstOutputs.get(fixture.name);
            comparisons.push({
              case: fixture.name,
              pytorch: agreement(fixture.expected, actual),
              againstFp32Export: baseline ? agreement(baseline, actual) : null,
            });
            if (model.id.endsWith('-fp32')) firstOutputs.set(fixture.name, actual);
          } finally {
            for (const value of Object.values(values)) value.dispose();
          }
        }
        const samplesMs: number[] = [];
        for (let index = 0; index < count; index++) {
          const fixture = modelFixtures[index % modelFixtures.length];
          if (!fixture) throw new Error('Missing timing fixture');
          status.textContent = `${model.id}: inference ${index + 1}/${count}`;
          const start = performance.now();
          const values = await session.run(fixture.feeds);
          samplesMs.push(performance.now() - start);
          for (const value of Object.values(values)) value.dispose();
        }
        results.push({
          model,
          p50Ms: percentile(samplesMs, 0.5),
          p95Ms: percentile(samplesMs, 0.95),
          samplesMs,
          comparisons,
        });
      } catch (error) {
        results.push({ model, error: String(error) });
      } finally {
        await session?.release();
      }
      output.textContent = JSON.stringify(results, null, 2);
    }
  } finally {
    for (const fixture of fixtures) {
      fixture.sorrelImages?.dispose();
      fixture.images.dispose();
      fixture.sizes.dispose();
    }
  }
  const report = {
    timestamp: new Date().toISOString(),
    userAgent: navigator.userAgent,
    ortVersion: ort.env.versions,
    requestedProvider: backend,
    crossOriginIsolated,
    wasmThreads: ort.env.wasm.numThreads,
    count,
    fixtureCount: fixtures.length,
    warmupRunsPerModel: fixtures.length,
    percentileMethod: 'nearest rank',
    timing: 'session.run with CPU outputs; excludes loading, preprocessing, agreement and disposal',
    agreement:
      'All 300 predictions, greedy class-preserving one-to-one IoU >= 0.99 and score error <= 0.001; TopK ties may reorder',
    reference: configuration.reference,
    results,
  };
  const json = JSON.stringify(report, null, 2);
  output.textContent = json;
  if (reportUrl) URL.revokeObjectURL(reportUrl);
  reportUrl = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  download.href = reportUrl;
  download.hidden = false;
  status.textContent =
    'Finished. Read per-model p50Ms, p95Ms and comparisons; save the JSON report.';
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const button = form.querySelector('button');
  if (button) button.disabled = true;
  download.hidden = true;
  void run()
    .catch((error: unknown) => {
      status.textContent = String(error);
    })
    .finally(() => {
      if (button) button.disabled = false;
    });
});
