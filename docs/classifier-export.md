# Classifier export

Status on 2026-11-05: native export and parity complete. Publication is pending. Same-model browser precision selection remains pending ADR 0003.

`tools/golden/run_cli.py` ran all five official SpeciesNet 5.0.6 CLI modes: no country, USA, GBR, detector-only and classifier-only. Each run covered all 16 images without prediction failures and contains 92 detections. The three full outputs and merged raw output each contain 38 classified detections, with five raw classes and scores each. The GBR American black bear source is `classifier+geofence+rollup_to_order`. Detector and classifier results are merged by filepath and detection geometry in `tests/golden/speciesnet_cli.raw.json`.

## Acquisition and provenance

The 16 JPEGs are pinned to `google/cameratrapai` commit `aebb5bf852238ee02dac0b82abeb36721ca5bff4`. Acquisition checked their Git blob hashes against that commit's file listing. Their URLs, byte counts and measured SHA-256 values are recorded in `tests/golden/upstream.provenance.json`.

The official detector is the `md_v5a.0.1.pt` named by the cached bundle's `info.json`, downloaded from `https://github.com/agentmorris/MegaDetector/releases/download/v5.0/md_v5a.0.1.pt`. Its 280,767,041 bytes match the release asset metadata and SHA-256 `fe3e90e4b1955821ab7c1f88b446dc0c8cb25e109fdd1872916a55305294a5ef`.

`tools/golden/acquire.py` verifies JPEG and detector downloads, including existing cached files, against the recorded size and SHA-256. A mismatch fails and incomplete downloads are removed. JPEGs live under `.cache/upstream/speciesnet/<commit>/test_data/`, with an ignored relative link at `tests/golden/upstream`. The detector lives under `.cache/speciesnet/`, linked into the Kaggle bundle using SpeciesNet's URL-derived filename. The Kaggle bundle is acquired before creating its detector link so an otherwise empty version directory cannot masquerade as a cached model.

All source downloads and exports remain in the ignored repository `.cache/`. Files were downloaded individually, leaving no archives to retain. After this run, `du -sh .cache` reported 875M and `df -h .` reported 69 GiB available. No account was created and no files were uploaded.

## Reproduction

Run these commands sequentially from `tools/`. The dependency groups share a virtual environment and must not be combined.

```sh
export UV_CACHE_DIR=/private/tmp/deerdiary-uv-cache
export XDG_CACHE_HOME="$PWD/../.cache"
export MPLCONFIGDIR="$PWD/../.cache/matplotlib"
export OMP_NUM_THREADS=1
uv sync --locked --exact --group reference
uv run --locked --exact --group reference python golden/acquire.py
uv run --locked --exact --group reference python golden/run_cli.py
uv run --locked --exact --group reference python export/speciesnet_crop.py --prepare-reference
uv sync --locked --exact --group onnx
uv run --locked --exact --group onnx python export/speciesnet_crop.py --check
```

The checkpoint is an `onnx2torch` graph, so loading it requires the reference group. That stage exports opset 17 with the legacy exporter and dynamic batch axes, then saves CPU PyTorch logits and model inputs under `.cache/speciesnet-reference/`. Every crop is checked byte-for-byte against SpeciesNet's own preprocessing before reference tensors are written. Coverage follows the official threshold of 0.1 and maximum of five detections per image. Seed 20261104 supplies two additional random inputs with batch sizes one and two, exercising dynamic batch inference.

The ONNX stage verifies source and tensor checksums before converting fp16 with float32 I/O. It requires fp32 maximum absolute logit difference strictly below `1e-4` and identical fp16 top-1 against PyTorch for every crop and random case. Failures stop before manifest updates. The export directory is `.cache/exports/speciesnet-v4.0.3a/`, containing both ONNX files, unchanged labels/taxonomy/geofence, `info.json`, an Apache-2.0 `LICENSE`, provenance `README.md` and `parity.json`.

## Measured parity

The acceptance command exited 0:

```text
PASS: 16 golden images, 38 CLI crops, 2 random batches; fp32 max abs 3.24249268e-05 < 0.0001; fp16 top-1 identical in every case
```

The largest difference was `3.24249267578125e-05` on `domestic_cattle.jpg#2`. Random batch sizes one and two had maximum differences `1.9073486328125e-05` and `1.811981201171875e-05`, respectively. There were 40 cases and 41 input rows in total. Native ONNX Runtime 1.31.1 used `CPUExecutionProvider`. Each output had 2,498 logits. Both exports take float32 `image` with shape `[batch,480,480,3]` and return float32 `logits` with shape `[batch,2498]`.

| Golden image                                  | Classified crops checked |
| --------------------------------------------- | -----------------------: |
| `african_elephants.jpg`                       |                        5 |
| `african_elephants_bw.jpg`                    |                        5 |
| `african_elephants_cmyk.jpg`                  |                        5 |
| `african_elephants_truncated_file.jpg`        |                        5 |
| `african_elephants_with_exif_orientation.jpg` |                        5 |
| `american_black_bear.jpg`                     |                        1 |
| `blank.jpg`                                   |                        0 |
| `blank2.jpg`                                  |                        0 |
| `blank3.jpg`                                  |                        0 |
| `domestic_cattle.jpg`                         |                        3 |
| `domestic_dog.jpg`                            |                        1 |
| `gazelles_and_zebra.jpg`                      |                        3 |
| `human.jpg`                                   |                        1 |
| `human_and_dog.jpg`                           |                        2 |
| `ocelot.jpg`                                  |                        1 |
| `vehicle.jpg`                                 |                        1 |

The three blank images correctly contribute no classified crops. All crops produced for the CMYK, truncated, grayscale and EXIF-oriented elephant images passed without exceptions or tolerance changes.

| Export                              |     Bytes | SHA-256                                                            |
| ----------------------------------- | --------: | ------------------------------------------------------------------ |
| `speciesnet-v4.0.3a-crop.fp32.onnx` | 223998777 | `833757b8a9677566e1c9aeeab73a36d8be0db83804a0aa551d685def43bf1ff4` |
| `speciesnet-v4.0.3a-crop.fp16.onnx` | 112296562 | `b5d078a96095ff9f59ce4abbdcd4dbec2aae80f0762ef644f5f4ecaacbb7dd34` |

The raw golden is 51,072 bytes, SHA-256 `03e549a0b45a560df0cea9f0437f4117d5efde6a76f160840ddf26cc139a4ab1`. `parity.json` records every case and hashes for source images, checkpoint, reference tensors and exports. Labels, taxonomy and geofence were verified byte-identical to the Kaggle bundle.

The manifest records measured local paths, sizes, SHA-256 and tensor metadata in `local_exports`. Publication keeps status `pending-publication`, repository `<owner>/deerdiary-speciesnet-v4.0.3a-crop-onnx` and null revision. Publishing must supply a real repository and full commit-pinned URLs. Browser precision selection remains pending; both artifacts are retained.

## Acquired Kaggle source evidence

Kaggle downloaded the six files individually into `.cache/kagglehub/models/google/speciesnet/pyTorch/v4.0.3a/1/`. No upstream source file was reformatted and no dependency pins or groups changed.

| File                                                            |     Bytes | Measured SHA-256                                                   |
| --------------------------------------------------------------- | --------: | ------------------------------------------------------------------ |
| `always_crop_99710272_22x8_v12_epoch_00148.pt`                  | 224393837 | `d099632044e92a0446869e06e5eb282e24706d5266b4acf5b42f5f23e2b50ade` |
| `always_crop_99710272_22x8_v12_epoch_00148.labels.20260609.txt` |    255693 | `e0c41415d9b29dfd6d2e2494205d1197d28595cc6f69cb129495f9827155547e` |
| `taxonomy_release.20260609.txt`                                 |    357417 | `4bd5d1a85a63857f557d487c5d86c0911173c59b34977ebc0ee909484ce277f2` |
| `geofence_release.20260609.json`                                |   6264811 | `27a88e932e411f73a4937c935fe36cf61a9060a1c488f4c69ade3f19eb8507d1` |
| `info.json`                                                     |       410 | `037133d121d48a5cd53884cdee01374564f32e2cc6f1375ffb39a9bc1cf6000a` |
| `README.md`                                                     |       119 | `5707c487b20aef8bb779d63c32d8ca11ee7d66c12e46ff4a366047622bf49811` |

These are locally measured integrity values, not an upstream signature. `speciesnet_source.py` pins and checks them. The labels file has 2,498 lines.

## Browser run

ADR 0003 remains open: run the exported fp16 and fp32 versions of this same model on WASM. Ship fp16 alone only if it runs and median latency is at most 1.2 times fp32; otherwise retain both, selecting fp16 for WebGPU and fp32 for WASM. Native CPU parity does not settle this decision.
