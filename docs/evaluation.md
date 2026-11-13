# Fidelity evaluation

On 2,000 ENA24 photos (USA), the WebGPU experiment using the default pipeline (fp32 detector, fp16 classifier) names the right species in **86.27%** of single-species photos (95% CI 84.57% to 87.72%); official SpeciesNet scores **86.72%** on the same photos. It agrees with the official empty-or-not call on **99.75%**. Exact label lists, one entry per detection, match on **40.20%**. ENA24 may overlap SpeciesNet training data, so this is not an independent benchmark. The WASM app build is not separately measured.

Reference mode is not evaluated here: its 16-image parity check has not passed yet.

| Pipeline         | Metric                                  | Measured | Bootstrap 95% CI |     Count |
| ---------------- | --------------------------------------- | -------: | ---------------: | --------: |
| Default (WebGPU) | Image label-list agreement              |   40.20% | 38.05% to 42.45% |  804/2000 |
| Default (WebGPU) | Detection agreement (IoU >= 0.5)        |   40.15% | 38.98% to 41.41% | 2106/5245 |
| Default (WebGPU) | Blank / non-blank agreement             |   99.75% | 99.50% to 99.95% | 1995/2000 |
| Default (WebGPU) | Missed animals / ENA24 animal images    |    0.16% |   0.00% to 0.37% |    3/1908 |
| Default (WebGPU) | Missed animals / official animal images |    0.16% |   0.00% to 0.37% |    3/1907 |
| Default (WebGPU) | ENA24 species accuracy (single species) |   86.27% | 84.57% to 87.72% | 1539/1784 |
| Default (WebGPU) | ENA24 family accuracy (single species)  |   93.61% | 92.49% to 94.60% | 1670/1784 |
| Default (WebGPU) | Animal labels rolled above species      |   23.33% | 21.36% to 25.26% |  642/2752 |
| Default (WebGPU) | Animal labels rolled above family       |   12.10% | 10.66% to 13.58% |  333/2752 |
| Official         | Missed animals / ENA24 animal images    |    0.31% |   0.10% to 0.58% |    6/1908 |
| Official         | ENA24 species accuracy (single species) |   86.72% | 85.12% to 88.21% | 1547/1784 |
| Official         | ENA24 family accuracy (single species)  |   93.72% | 92.56% to 94.77% | 1672/1784 |
| Official         | Animal labels rolled above species      |   20.08% | 18.20% to 22.05% |  435/2166 |
| Official         | Animal labels rolled above family       |   12.00% | 10.52% to 13.51% |  260/2166 |

## Dataset and interpretation

Country USA; 2,000 distinct public ENA24 images; seed 20261104; class-stratified,
not a prevalence-weighted estimate. ENA24 provides no empty-category ground
truth, so blank agreement is against official outputs, not blank specificity.
Images are disjoint from the 1,000-path
substitute detector holdout in [ADR 0013](adr/0013-ena24-evaluation-holdout.md).
The substitute detector was not compared against the original on a separate holdout.
Image transfer: 926,602,630 bytes. Dataset provenance, boxes,
dimensions and checksums are committed in `tools/eval/results/dataset.json`.
Original [ENA24 metadata](https://storage.googleapis.com/public-datasets-lila/ena24/ena24.json) SHA-256:
`8b426c87c948ab91dda10e5b210fc469db8b0c095a15cc7c03bb4ddceffa3160`.

Intervals use 1,000 percentile bootstrap resamples, seed 20261104, by
image. The original metadata was inspected: no location,
location_id or camera_id fields exist. Correlated frames can make image-bootstrap
intervals optimistic; these intervals are not camera-independent estimates.
SpeciesNet training data may include ENA24. Accuracy here is **not an independent
benchmark** of generalization.

## Fixed definitions

- Image agreement compares sorted lists of processed classes, preserving duplicates.
  No classified detections means blank. Blank agreement compares blank/non-blank,
  so an unclassified-only image is blank under this convention.
- Detection agreement uses maximum-cardinality one-to-one geometric matching at
  IoU >= 0.5; free candidates are preferred, with descending IoU and original
  index as deterministic tie-breaks before augmenting the matching.
  Classes are compared after matching. Denominator: matched pairs plus unmatched
  classified detections on either side. Unclassified boxes are excluded.
- An animal is the animal label or a taxonomy descendant. A missed animal has no
  animal label despite an ENA24 animal box (human and vehicle boxes excluded), or
  despite an animal label in the official run. Rates use those positive images.
- Accuracy uses images with exactly one distinct ENA24 animal species. A species
  match is present in the predicted list; family accuracy requires a label at
  family level or below in that family. Above-family labels fail both accuracies.
  Generic Bird and vehicle-only images have no species target and are excluded;
  29 images with multiple animal categories are excluded. The
  rollup shares use classified animal labels as their denominator; both all
  above-species rollups and the above-family subset are shown.

## Reproduce

```sh
uv sync --project tools --locked --group reference
uv run --project tools --group reference python tools/eval/ena24_sample.py \
  --n 2000 --seed 20261104 --exclude tools/eval/lists/selection_1000.txt \
  --out tools/eval/lists/eval_2000.txt
uv run --project tools --group reference python tools/eval/run_official.py
uv run --project tools python tools/eval/prediction_files.py tools/eval/results/official_usa.json
npm run bench:photos -- --files tools/eval/data/eval_2000 --mode default \
  --country USA --export tools/eval/results/wild_default.json \
  --results tools/eval/results/wild_default.run.json
uv run --project tools python tools/eval/prediction_files.py tools/eval/results/wild_default.json
npm run eval:report
```

The official run uses SpeciesNet 5.0.6 / v4.0.3a, cached classifier and MDv5a
weights, batch size one, top five classes per image and per detection. CPU math
libraries are limited to one thread. Browser export runs only its requested
backend; the default export requests WebGPU (with ORT operator fallback), the fp32
RT-DETR detector and fp16 crop-classifier exports selected by the app's shared
model-selection function. The WebGPU experiment uses the app's production model
choices with a different execution backend. The app selects WASM and is not
separately measured. Pass `--wasm` and a separate export path to the browser
benchmark to measure that backend without replacing the WebGPU evidence.
Run records in `tools/eval/results/` retain versions, timings and weight hashes.
Prediction exports are small indices plus checksum-verified gzip shards of 100
images, preserving every raw detection and classification without rounding.
On this Mac set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to the installed Brave binary.
`npm run eval:report` needs only committed small files, not images or weights.
