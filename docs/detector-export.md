# RT-DETR export

Status on 2026-11-05: the bounded detector export job is complete on CPU. Default-detector selection still requires the paired dataset comparison and browser measurements. Publication is pending.

## Reproduction

Run sequentially from `tools/`; the two locked dependency groups share a virtual environment:

```sh
export UV_CACHE_DIR=/private/tmp/deerdiary-uv-cache
export XDG_CACHE_HOME="$PWD/../.cache"
export MPLCONFIGDIR="$PWD/../.cache/matplotlib"
export OMP_NUM_THREADS=1
uv run --locked --exact --group reference python export/rtdetr_apache.py --prepare-reference
uv run --locked --exact --group onnx python export/rtdetr_apache.py --check
```

Preparation verifies or downloads the pinned checkpoint and 16 golden JPEGs, checks preprocessing against torchvision's PIL transform, exports fp32, and saves PyTorch inputs and outputs. The ONNX stage verifies hashes for the checkpoint, golden provenance, images, fp32 graph and reference tensors before writing fp16 and checking fp32 inference. It updates the manifest only after all parity checks pass. Both stages stop when free disk space is below 30 GiB.

Artifacts live under ignored `.cache/exports/MDV6-apa-rtdetr-c/`; reference fixtures and their source hashes live under `.cache/rtdetr-reference/`. The exported directory also contains `parity.json`, a model card and the PytorchWildlife MIT notice. All model downloads remain in repository-local `.cache/`. No archives were downloaded or retained. `df -h .` reported 68 GiB available after export.

## Verified loader and source

Before implementation, read these files from the locked PytorchWildlife 1.3.1 wheel:

- `models/detection/rtdetr_apache/megadetectorv6_apache.py`: compact checkpoint URL, class indices and 640 px input.
- `rtdetr_apache_base.py`: r18vd configuration, EMA state preference, `deploy()` model/postprocessor and PIL `Resize((640,640))` followed by `ToTensor()`.
- `rtdetrv2_pytorch/src/rtdetr/rtdetr_postprocessor.py`: sigmoid, top-300 query/class pairs, cxcywh-to-xyxy conversion and original-size scaling. There is no NMS or confidence filtering in this deployment graph.

The exporter uses that wheel's `YAMLConfig`, model and postprocessor. It sets `PResNet.pretrained=False` to prevent an unnecessary backbone download, then strictly loads the complete detector state using the loader's EMA-first rule. The checkpoint is verified before `torch.load(..., map_location="cpu", weights_only=False)`. The package files are unmodified. The legacy exporter succeeded at the first prescribed attempt: opset 17 with postprocessing. Opset 16 and the decoder-free fallback were unnecessary.

The checkpoint from [Zenodo record 15398270](https://zenodo.org/records/15398270) is 322,443,686 bytes. Its MD5 matches the record API's `3992888e26f627ee5a4ff9f116be97c3`; measured SHA-256 is pinned as `4814cdbc9a0dbf20e4b04495f060176d8340b00d182fc98ce808a4d14a2a6fce`. The wheel's SHA-256 in `tools/uv.lock` is `9c678e5a7f44dce53d0235f541cf3b87e537c1bc107261bb8deda01add4b5ad6`.

Selected measured package-file SHA-256 values, relative to `models/detection/rtdetr_apache/`:

| File                                                                     | SHA-256                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `megadetectorv6_apache.py`                                               | `07b83cdd39d0828092e7d0520287cbd6a8c4222d1ffea8ce508806bd15bc4190` |
| `rtdetr_apache_base.py`                                                  | `f216ef51f2b25be61cb30ea50423b2597b0b21be4338ea1c65b7cc7063f2574e` |
| `rtdetrv2_pytorch/configs/rtdetrv2/rtdetrv2_r18vd_120e_megadetector.yml` | `868886f81703c81bcd5f60add8125b04fd1510dac8127dbb5ba23a8c5dff7208` |
| `rtdetrv2_pytorch/src/rtdetr/rtdetr_postprocessor.py`                    | `a7c2697faeac8a242926bf0449d288c19d8f1bf4557e558323140be57f96b7e5` |

All Python/YAML files in this package subtree are hashed in the local reference and parity records. Golden JPEGs use the existing `tests/golden/upstream.provenance.json`, pinned to `google/cameratrapai` commit `aebb5bf852238ee02dac0b82abeb36721ca5bff4`.

## Input and output contract

Decode RGB, apply EXIF orientation and ignore ICC profiles, as in the existing golden pipeline. Resize the entire PIL image with BILINEAR to 640×640, without letterboxing, then divide uint8 pixels by 255. Preparation verifies equality with the package's torchvision PIL transform. Spatial dimensions and batch size are fixed.

| Tensor              | Type    | Shape           | Meaning                              |
| ------------------- | ------- | --------------- | ------------------------------------ |
| `images`            | float32 | `[1,3,640,640]` | NCHW RGB in 0..1                     |
| `orig_target_sizes` | int64   | `[1,2]`         | `[width,height]` after orientation   |
| `labels`            | int64   | `[1,300]`       | 0 animal, 1 person, 2 vehicle        |
| `boxes`             | float32 | `[1,300,4]`     | xyxy in original-image pixels        |
| `scores`            | float32 | `[1,300]`       | Sigmoid confidence, descending top-k |

Both exported precisions retain this interface. Coordinates are neither clipped nor normalized in the graph. Normalize x by width and y by height when adapting these boxes to the later pipeline. Top-k operates over query/class pairs, so multiple classes may reference the same query box. No app decoder changes are included in this job.

## Measured parity and exports

PyTorch 2.15.0 and ONNX Runtime 1.31.1 used CPU only, with one inference thread. Each case checks all 300 predictions, including very low-confidence predictions on blank images. Matching is one-to-one and class-preserving; box IoU must be at least 0.99 and confidence difference at most 0.001. Matching allows top-k ties to reorder. There is no confidence threshold that could hide a discrepancy.

```text
PASS: 16 golden images, 2 random inputs, 300 queries each; fp32 min IoU 0.99988544 >= 0.99; max conf error 1.67787075e-05 <= 0.001; fp16 written and checked
```

Seed 20261104 supplies two independent `[1,3,640,640]` uniform random tensors, with original sizes `[1920,1080]` and `[640,960]`. This covers 5,400 predictions across 18 cases. Minimum IoU is on `african_elephants.jpg`; maximum confidence error is on the EXIF-oriented elephant image.

| Case                                          | Minimum IoU | Maximum confidence difference |
| --------------------------------------------- | ----------: | ----------------------------: |
| `african_elephants.jpg`                       | 0.999885440 |                   3.784895e-6 |
| `african_elephants_bw.jpg`                    | 0.999972761 |                   1.093745e-5 |
| `african_elephants_cmyk.jpg`                  | 0.999965250 |                   1.057982e-5 |
| `african_elephants_truncated_file.jpg`        | 0.999964297 |                   3.367662e-6 |
| `african_elephants_with_exif_orientation.jpg` | 0.999941528 |                   1.677871e-5 |
| `american_black_bear.jpg`                     | 0.999978602 |                   3.054738e-7 |
| `blank.jpg`                                   | 0.999923587 |                   8.299947e-6 |
| `blank2.jpg`                                  | 0.999913990 |                   1.192093e-6 |
| `blank3.jpg`                                  | 0.999955237 |                   3.471971e-6 |
| `domestic_cattle.jpg`                         | 0.999970496 |                   5.856156e-6 |
| `domestic_dog.jpg`                            | 0.999959230 |                   3.144145e-6 |
| `gazelles_and_zebra.jpg`                      | 0.999956846 |                   1.847744e-6 |
| `human.jpg`                                   | 0.999980569 |                   2.026558e-6 |
| `human_and_dog.jpg`                           | 0.999975324 |                   8.508563e-6 |
| `ocelot.jpg`                                  | 0.999980450 |                   1.832843e-6 |
| `vehicle.jpg`                                 | 0.999981225 |                   3.874302e-7 |
| `random-1`                                    | 0.999959230 |                   1.803041e-6 |
| `random-2`                                    | 0.999947190 |                   2.160668e-6 |

| Artifact                      |    Bytes | SHA-256                                                            |
| ----------------------------- | -------: | ------------------------------------------------------------------ |
| `MDV6-apa-rtdetr-c.fp32.onnx` | 80252664 | `903b6c07f4d669214fedf18926b40bf8ba5386cadbd3a922fb3f1700e37743ab` |
| `MDV6-apa-rtdetr-c.fp16.onnx` | 40289717 | `b464f1ec072202618ad6be4ae73593eca70a464bd05cc7597170eca358c09e74` |

fp16 conversion uses `onnxconverter-common` 1.16.0 with `keep_io_types=True`, followed by full ONNX checker validation. That converter left an original integer-to-float cast's `to` attribute inconsistent with its converted tensor metadata and changed the score output to float16 despite the I/O option. `export/fp16.py` repairs those two inconsistencies, asserts original I/O names/types, and retains full validation. Regression tests check cast execution and mixed float/integer outputs with the ONNX reference evaluator. Conversion warnings about clamped infinity and small constants remain visible in `.cache/rtdetr-check.log`. fp16 numerical parity and browser execution remain unverified; graph validity does not prove either.

The fp32 graph has two `TopK`, nine `GridSample` and twelve `LayerNormalization` nodes, with no `NonMaxSuppression` or `NonZero`. Operator histograms for both graphs are in the manifest. Browser support must be measured rather than inferred from these counts.

## Manifest, licence and remaining work

`local_detector_exports` follows the existing classifier `local_exports` metadata pattern while preserving that block and all published model entries. It records both detector paths, measured integrity, provenance, tensor types/shapes and operator histograms. The candidate has no runtime URL. Publication retains `<owner>/deerdiary-mdv6-apa-rtdetr-c-onnx`, status `pending-publication` and null revision. Publishing requires a real repository and full commit-pinned URLs.

The [PytorchWildlife model zoo](https://github.com/microsoft/pytorch-wildlife/blob/main/docs/model_zoo.md) identifies this specific model as Apache 2.0. The Zenodo record API reports CC-BY-4.0 for the collection. The manifest retains the Apache identifier with an explicit discrepancy note; I have not made a final redistribution decision. Before publication, resolve which terms apply to these weights and carry the applicable notices. The exported wrapper notice is MIT, distinct from the weight licence.

Only native fp32 export parity is established here. Criteria involving browser support, matched false-detection recall, small-animal recall and WebGPU latency remain pending. The detector plus the WebGPU crop classifier file totals 152,586,279 bytes with fp16 or 192,549,226 bytes with fp32, both below the 200 MB weight budget; browser precision support still needs testing. No default detector is selected. The ensemble keeps its MDv5a-calibrated thresholds. MegaDetector-family training includes LILA collections and may include ENA24 and CCT, so future absolute recall estimates are optimistic; selection must rely on the planned comparison and paired intervals.

## Verification

Both groups passed sequentially on 2026-11-05. From `tools/`, for each of `reference` and `onnx`, ran `uv run --locked --exact --group <group>` with `ruff check .`, `ruff format --check .`, `pyright` and `pytest`. Results: `All checks passed!`, `21 files already formatted`, `0 errors, 0 warnings, 0 informations`, and `30 passed` (0.15 s for reference, 0.17 s for ONNX). Existing Pyright notices name planned directories that are absent. No checks were suppressed or skipped. The environment is left on the ONNX group.

`npm run check` passed with `Test Files 8 passed (8)` and `Tests 37 passed (37)`. Biome retains its existing informational configuration deprecation notice. `git diff --check` passed. No dependencies, pins, app files or end-to-end tests changed.

Because the fp16 utility is shared, reran `uv run --locked --exact --group onnx python export/speciesnet_crop.py --check`. It passed all 38 golden crops and two random batches, with unchanged maximum absolute fp32 logit error `3.24249268e-05` and identical fp16 top-1. Classifier artifact hashes remained unchanged. This is native CPU regression evidence; ADR 0003's browser precision question remains pending.
