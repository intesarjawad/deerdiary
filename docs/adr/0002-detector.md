# 0002: Detector evidence and selection

Status: accepted production default decision on 2026-11-05. Publication and comparative evaluation remain pending.

## Model graph inspection and reproduction

Probed on 2026-11-05 using the locked ONNX group. The manifest contains six files with commit-pinned Hugging Face URLs: sorrel, MDv5a, both classifier fallbacks, Perch without DFT, and Perch labels. Downloads use `hf_hub_download` with an explicit 40-hex `revision`; bytes and SHA-256 are computed from each downloaded file. ONNX entries carry measured tensor names, dtypes, shapes and dynamic axes. The probe recursively counts operators in subgraphs and reports occurrences of three operators checked for browser compatibility: `NonMaxSuppression`, `NonZero` and `TopK`.

From `tools/`:

```sh
UV_CACHE_DIR=/private/tmp/deerdiary-uv-cache HF_XET_CACHE=/private/tmp/deerdiary-xet \
  uv run --locked --exact --group onnx python export/probe_onnx.py --fill-manifest \
    --cache-dir /private/tmp/deerdiary-models
uv run --locked --exact --group onnx pytest tests/test_probe.py
```

These are graph inspections, not inference or browser support measurements. The missing-operator report uses a three-operator watchlist, not an exhaustive compatibility audit. Browser measurements must test actual execution providers and timings.

Other artifacts do not yet have runtime ONNX URLs: the versioned Zenodo MDV6 checkpoint is a detector export input, and the Kaggle v4.0.3a weights, classifier labels, taxonomy and geofence are classifier export inputs. They are not silently replaced with either fallback classifier. Their published runtime files must acquire pinned URLs and measured integrity metadata before runtime use. No publication or account is required for this probe.

## Detector findings

MDv5a has a fixed float32 input `[1,3,1280,1280]` and output `[1,102000,8]`. There are no dynamic input axes. This requires exporting the official `md_v5a.0.1.pt` weights with dynamic height and width before Reference mode ships. The current ONNX file remains useful for browser execution and detector comparison measurements. The fallback environment must respect the existing Python dependency ADR, which excludes megadetector from the shared reference group.

Sorrel has float32 input `[batch,3,height,width]`, with dynamic axes 0, 2 and 3, and float32 output `[batch,300,6]`. Sorrel uses the advertised 960 px input; symbolic graph dimensions do not prove arbitrary image-size support. Its graph contains one `NonMaxSuppression` and one `NonZero`; browser execution needs execution-provider verification.

Upstream ensemble thresholds are calibrated to MDv5a confidence. A different detector cannot claim label-for-label parity; default-mode agreement awaits paired detector evaluation. The production selection is recorded below; these initial probes did not select it.

## Pasted probe output

### sorrel

```text
{
  "id": "sorrel",
  "opsets": {
    "ai.onnx": 17
  },
  "inputs": [
    {
      "name": "images",
      "dtype": "FLOAT",
      "shape": [
        "batch",
        3,
        "height",
        "width"
      ],
      "dynamic_axes": [
        0,
        2,
        3
      ]
    }
  ],
  "outputs": [
    {
      "name": "output0",
      "dtype": "FLOAT",
      "shape": [
        "batch",
        300,
        6
      ],
      "dynamic_axes": [
        0
      ]
    }
  ],
  "op_histogram": {
    "Add": 22,
    "ArgMax": 1,
    "Cast": 9,
    "Concat": 42,
    "ConstantOfShape": 4,
    "Conv": 88,
    "Div": 1,
    "Expand": 7,
    "Gather": 23,
    "GatherND": 3,
    "Greater": 1,
    "MatMul": 2,
    "MaxPool": 3,
    "Mul": 86,
    "NonMaxSuppression": 1,
    "NonZero": 1,
    "Pad": 1,
    "Range": 6,
    "ReduceMax": 2,
    "Reshape": 27,
    "Resize": 2,
    "ScatterND": 1,
    "Shape": 16,
    "Sigmoid": 78,
    "Slice": 9,
    "Softmax": 2,
    "Split": 10,
    "Squeeze": 1,
    "Sub": 2,
    "Transpose": 7,
    "Unsqueeze": 23,
    "Where": 1
  },
  "webgpu_missing_ops": {
    "NonMaxSuppression": 1,
    "NonZero": 1
  }
}
```

### mdv5a

```text
{
  "id": "mdv5a",
  "opsets": {
    "ai.onnx": 17
  },
  "inputs": [
    {
      "name": "images",
      "dtype": "FLOAT",
      "shape": [
        1,
        3,
        1280,
        1280
      ],
      "dynamic_axes": []
    }
  ],
  "outputs": [
    {
      "name": "output",
      "dtype": "FLOAT",
      "shape": [
        1,
        102000,
        8
      ],
      "dynamic_axes": []
    }
  ],
  "op_histogram": {
    "Add": 36,
    "Cast": 3,
    "Concat": 29,
    "Constant": 54,
    "Conv": 163,
    "Floor": 6,
    "MaxPool": 3,
    "Mul": 175,
    "Pow": 4,
    "Reshape": 8,
    "Resize": 3,
    "Shape": 3,
    "Sigmoid": 163,
    "Slice": 3,
    "Split": 4,
    "Transpose": 4,
    "Unsqueeze": 6
  },
  "webgpu_missing_ops": {}
}
```

## Licence evidence for the later selection

The manifest records repository declarations, not a new licence decision:

- Sorrel retains the `CC-BY-SA-4.0` repository tag. The [pinned card](https://huggingface.co/NINAnor/deepfaune-v1.5/blob/8e2f073a24633d022ea725af4b5c499b5a40a1d2/README.md) separately attributes the sorrel weights and ONNX export to MegaDetector under MIT. This discrepancy must be resolved during detector selection before final detector licence copy is written.
- The [MDv5a pinned card](https://huggingface.co/malyvsen/megadetector-v5a-onnx/blob/f042c11430241afaf986a1f856f0d2552811628f/README.md) declares MIT for its source weights and export. This is distinct from the YOLOv5 implementation licence.
- The [v4.0.1a fallback card](https://huggingface.co/daslearning/Google-SpeciesNet-ONNX/blob/9022b5f81b49ee090dd8f384581178d1c7432ff3/README.md) has an MIT repository tag; that declaration alone does not settle upstream SpeciesNet weight attribution. The chosen classifier export must carry upstream notices.
- The pinned cards for [v4.0.3b](https://huggingface.co/sasakiuri/speciesnet-v4.0.3b-onnx/blob/7317802fda363b1c9dd91e5a8769bdbb77814514/README.md), [Perch](https://huggingface.co/justinchuby/Perch-onnx/blob/da88bf8c37c0b3068fc706fe509f633b9fbd28c1/README.md), and [Perch labels](https://huggingface.co/Calotriton/perch-v2-onnx/blob/bb0f724ee99fa4e0dc3637d8bbdc6a0e26660480/README.md) declare Apache 2.0.

Final README detector licence text, parity, evaluation intervals and browser measurements remain pending.

## Acquisition results

All six downloaded byte counts match section 5. The Perch labels SHA-256 also matches its pinned model card, as does the full-image fp16 classifier SHA-256. The manifest stores the complete measured digest for every file.

The download cache is `/private/tmp/deerdiary-models` on this machine, outside the repository. The script defaults to `deerdiary-models` under the platform temporary directory and accepts `--cache-dir` for a persistent local cache. No weights are committed. Because this scaffold had no manifest, `git diff --stat models/manifest.json` is empty until staging; `git diff --no-index --stat /dev/null models/manifest.json` reports the new manifest without staging it.

## Verification on 2026-11-05

- The acquisition command above exits 0 and emits six probe records. Sorrel and MDv5a records match the pasted output verbatim. The new manifest has 253 lines; the no-index diff reports `1 file changed, 253 insertions(+)`.
- `uv run --locked --exact --group onnx pytest tests/test_probe.py`: `8 passed in 0.11s`. Tests cover byte count, SHA-256, metadata preservation, rejected branch/tag/short/invalid revisions, mismatched provenance and populated integrity fields for the checked-in manifest.
- For each group, `reference` then `onnx`, ran `uv run --locked --exact --group <group>` with each of `ruff check .`, `ruff format --check .`, `pyright`, and `pytest`. Both groups pass: `All checks passed!`, `4 files already formatted`, `0 errors, 0 warnings, 0 informations`, and `9 passed in 0.09s`. Existing notices about absent planned Python directories remain. The environment is left on the ONNX group.
- `npm run check` passes: `Test Files 2 passed (2)` and `Tests 3 passed (3)`. Biome retains the scaffold's informational configuration notice.
- Browser execution, inference parity and detector selection were not tested during graph inspection.

## Browser execution

On 2026-11-05, `npx playwright test smoke --project=chromium-headful` ran in a headed session; the measurements are below.

The harness uses the model cache, defaulting to `deerdiary-models` under the system temporary directory; `HF_HUB_CACHE` selects another cache. It verifies the manifest byte count and SHA-256 before serving each ONNX file. Dynamic detector spatial dimensions use 960 pixels, as specified for sorrel above; dynamic batch dimensions use one. Measurements include five runs without a separate warm-up. WebGPU sessions may fall back to WASM for individual operators, so the requested provider is not proof that every operator ran on the GPU. Record requested ORT `.wasm` and `.mjs` files in ADR 0001 after a successful run.

## Browser execution measurements (2026-11-05, headed Chromium, Apple M5, crossOriginIsolated true)

Median of 5 zero-tensor runs per the harness; WebGPU sessions may fall back to WASM per operator.

| Model  | Input         | WebGPU median ms | WASM median ms | Output shapes       |
| ------ | ------------- | ---------------- | -------------- | ------------------- |
| sorrel | 1x3x960x960   | 51.1             | 433.5          | output0 [1,300,6]   |
| mdv5a  | 1x3x1280x1280 | 479.2            | 5681.2         | output [1,102000,8] |

## RT-DETR export result (2026-11-05)

The MDV6-apa-rtdetr-c candidate exports successfully at the first prescribed attempt: ONNX opset 17 with the PytorchWildlife 1.3.1 deployment postprocessor in the graph. CPU fp32 parity passes all 300 predictions on each of the 16 pinned golden images and two seeded random inputs. Minimum box IoU is `0.9998854398727417` against the required `0.99`; maximum confidence difference is `0.00001677870750427246` against `0.001`. This establishes selection criterion (a).

The fp32 file is 80,252,664 bytes; fp16 is 40,289,717 bytes. fp16 is written and passes full graph validation; numerical parity and browser support are unverified. Both retain float32 images, boxes and scores, with int64 original sizes and labels. Input is `[1,3,640,640]` after PIL BILINEAR stretching; `orig_target_sizes` is `[1,2]` in width/height order. Outputs are labels `[1,300]`, original-image xyxy boxes `[1,300,4]` and sigmoid scores `[1,300]`. The graph includes two `TopK` nodes. Full hashes, per-image parity, decoder semantics, conversion fixes and reproduction commands are in [the export record](../detector-export.md).

The manifest adds `local_detector_exports` with the existing pending-publication pattern and `<owner>/deerdiary-mdv6-apa-rtdetr-c-onnx` placeholder. Published model entries and classifier export metadata are preserved. No runtime URL or default selection is asserted. Native CPU parity does not establish browser operation or latency. The remaining selection criteria and ENA24/CCT comparison are outside this bounded export job and remain pending.

The browser run on 2026-11-05 (headed Chromium, Apple M5, crossOriginIsolated true, median of 5 zero-tensor runs) establishes browser operation for both exports: fp32 ran WebGPU 45.8 ms / WASM 363.2 ms; fp16 ran WebGPU 34.2 ms / WASM 374.6 ms, a WASM ratio of 1.03. Latency therefore does not block fp16; its numerical parity and the remaining selection criteria still do.

Licence evidence remains open: the model zoo declares Apache 2.0 for this specific checkpoint, while the Zenodo collection API reports CC-BY-4.0. The manifest retains the recorded Apache identifier with this discrepancy recorded. Resolution of the applicable weight terms is required before publication and final README licence text. The package wrapper's MIT notice is copied beside the exports.

The later evaluation must keep these caveats: ensemble confidence thresholds are calibrated to MDv5a; MegaDetector-family training includes LILA collections and may include ENA24 and CCT, making absolute recall optimistic. The planned matched-false-detection comparison, paired intervals, browser execution and latency determine selection, not this export result alone.

## Production default decision (2026-11-05)

Use **mdv6-apa-rtdetr-c fp32** as the production default. The manifest selects
`mdv6-apa-rtdetr-c-fp32`; sorrel remains a comparison candidate. Preprocessing is
whole-image PIL BILINEAR stretching to 640x640, RGB float32 NCHW in 0..1, with
original oriented width/height supplied to the deployment graph. The graph returns
original-image xyxy boxes, labels and sigmoid top-k scores; do not apply NMS again.

Evidence supplied from two independent local development benchmark runs using
`tools/bench/detector.html`: HeadlessChrome 157, onnxruntime-web 1.31.1, WebGPU,
32 timed runs per measurement. These are local development measurements, not a
published evaluation or an end-to-end throughput claim.

| Precision | p50 ms (two-run range) | p95 ms (two-run range) | Size    | Reference agreement                                                               |
| --------- | ---------------------- | ---------------------- | ------- | --------------------------------------------------------------------------------- |
| fp32      | 43.6-48.1              | 47.0-59.2              | 80.3 MB | All 16 cases match 300/300 queries; minimum IoU 0.99991, maximum score error 1e-4 |
| fp16      | 32.2-38.1              | Not supplied           | 40.3 MB | Strict all-300-query agreement fails: 11-81 of 300 matched                        |

The fp32 result satisfies reference parity under the benchmark's matching
criteria. fp16 is faster and smaller but stays a documented non-default option.
Pending evidence: compare only detections above the product confidence threshold
and prove top-detection equivalence before considering fp16 as the default. That
thresholded comparison has not been run as part of this decision.

The decision unblocks default-detector preprocessing. It does not establish the
planned matched-false-detection comparison or its intervals, resolve the weight
licence discrepancy, or replace paired detector agreement measurements. The MDv5a-calibrated
ensemble thresholds and ENA24/CCT training-overlap caveats above still apply.
Runtime publication remains pending; no unpublished model URL is fabricated.

## Reference mode wiring

Reference mode runs the MDv5a detector through `createPhotoModels(..., 'reference')`. Photos are letterboxed to 1280 with grey 114 padding and OpenCV-style bilinear resizing, rows are decoded by `decodeYolov5` (class-aware NMS at 0.45, thresholds from `core/nms.ts`), and boxes are mapped back with the `scale_boxes` rounding. The padding follows the loaded graph: a dynamic height and width gets the official minimum stride-64 rectangle, while the fixed `[1,3,1280,1280]` graph from the published `md_v5a.0.0.onnx` gets a square, which can move boxes slightly against the official pipeline.

`tools/export/fp16.py verify <fp32> <fp16> <images...>` runs both graphs on the same letterboxed inputs and fails unless every detection pairs within its class at box IoU 0.99 or better and confidence within 0.005. `tests/e2e/reference.spec.ts` skips until the converted file is recorded in `local_detector_exports` with role `detector_reference`.

Open: neither the fp16 conversion nor the golden comparison has been run, so no fp16 size, speed or agreement figure is recorded. Because the published graph has a fixed input shape, the fallback applies if the comparison misses IoU 0.99: export `md_v5a.0.1.pt` with dynamic height and width in `tools/export/mdv5a.py`. That needs the `megadetector` package in an isolated environment, which `python-dependencies.md` keeps out of the shared project, so it needs its own decision first.
