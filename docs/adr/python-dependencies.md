# Reference and ONNX dependency groups on Python 3.12

Status: decided on 2026-11-05. Supersedes the blocked proposal for an independent reference project.

## Context

MegaDetector 10.0.28 requires ultralytics-yolov5 0.1.1, whose requirements include protobuf <=3.20.1. Together with SpeciesNet's onnx2torch dependency, this forced reference resolution to ONNX 1.12.0. The pinned torch 2.15.0 requires Python >=3.11, where that ONNX release has no wheels. Moving to Python 3.10 or a separate project cannot satisfy the unchanged pins and required platforms.

No script imports the megadetector package. The official reference pipeline uses the SpeciesNet 5.0.6 CLI, which carries its MDv5a path through the distinct yolov5 package.

## Decision

Remove megadetector 10.0.28 from the reference group and let its exclusive transitive dependencies, including ultralytics-yolov5, leave the lockfile. Keep every remaining direct pin and Python 3.12 in tools/pyproject.toml. Retain the mutually exclusive reference and onnx groups and the existing workflow matrix. No separate reference project is needed.

If later work genuinely needs the megadetector package, make a new isolated environment decision at that time. Do not add it back to this shared project without that decision.

## SpeciesNet dependency evidence

Checked [SpeciesNet 5.0.6 release metadata](https://pypi.org/pypi/speciesnet/5.0.6/json) on 2026-11-05: it declares `yolov5>=7.0.8,<7.0.12`, `onnx2torch`, and `torch>=2.0`, and provides a `py3-none-any` wheel. I verified the MDv5a reference path.

The [yolov5 7.0.8 metadata](https://pypi.org/pypi/yolov5/7.0.8/json) and [7.0.11 metadata](https://pypi.org/pypi/yolov5/7.0.11/json) provide pure Python wheels and declare no ONNX or protobuf requirements. These are different distributions from ultralytics-yolov5 0.1.1. The regenerated lock resolves ONNX 1.23.2 and protobuf 7.36.2 without the old chain; all remaining direct pins are unchanged.

## Wheel verification

Checked PyPI release metadata on 2026-11-05:

| Package                  | Python 3.11, macOS arm64 | Python 3.11, Linux x86_64 | Python 3.10, macOS arm64 | Python 3.10, Linux x86_64 |
| ------------------------ | ------------------------ | ------------------------- | ------------------------ | ------------------------- |
| ONNX 1.12.0              | No wheel                 | No wheel                  | No wheel                 | Wheel available           |
| torch 2.15.0             | Wheel available          | Wheel available           | Unsupported Python       | Unsupported Python        |
| ultralytics-yolov5 0.1.1 | No wheel                 | No wheel                  | No wheel                 | No wheel                  |

Sources: [ONNX release metadata](https://pypi.org/pypi/onnx/1.12.0/json), [torch release metadata](https://pypi.org/pypi/torch/2.15.0/json), and [ultralytics-yolov5 release metadata](https://pypi.org/pypi/ultralytics-yolov5/0.1.1/json).

ONNX 1.12.0 wheels stop at CPython 3.10; its macOS wheels are x86_64 only. Torch 2.15.0 declares `Requires-Python: >=3.11` and publishes no CPython 3.10 wheels. ultralytics-yolov5 0.1.1 publishes only an sdist, so a strictly wheel-only installation fails on either Python version independently of ONNX.

The ultralytics-yolov5 sdist was inspected in memory without extracting or executing upstream code. Its `pyproject.toml` lists only setuptools and wheel as build requirements. `requirements.txt` supplies the protobuf bound; ONNX 1.12.0 is a resolved transitive runtime dependency, not an explicit build-system pin. Allowing only this pure Python sdist to build would still leave the ONNX wheel and Python compatibility failures.

Wheel-only resolver probes used the existing interpreter to resolve target Python versions without installing them. From the repository root:

```sh
printf 'onnx==1.12.0\n' | uv pip compile - \
  --python tools/.venv/bin/python --python-version 3.11 \
  --python-platform aarch64-apple-darwin --only-binary :all: --no-cache
```

Repeat for Python 3.10 and platform `x86_64-unknown-linux-gnu`. Results match the ONNX table: all exit 1 except Linux x86_64 with Python 3.10, which exits 0 with `Resolved 4 packages`. Separate probes for torch 2.15.0 on Python 3.10 and ultralytics-yolov5 0.1.1 on Python 3.11 exit 1. Representative output:

```text
error: No solution found when resolving dependencies
  cause: Because onnx==1.12.0 has no usable wheels and you require onnx==1.12.0, we can conclude that your requirements are unsatisfiable.
```

`required-environments` cannot create missing wheels. Per uv's [required environments documentation](https://docs.astral.sh/uv/concepts/resolution/#required-environments), it checks wheel coverage for packages without an sdist; it does not by itself prevent source builds for ONNX or ultralytics-yolov5. Context7 also confirmed `--no-build`/`--only-binary` for rejecting source builds. The probes used `--no-cache` to avoid accepting locally built wheels.

## Script environments

From `tools/`, install and run the reference environment with:

```sh
uv sync --locked --exact --group reference
uv run --locked --exact --group reference python -c 'import speciesnet'
uv run --locked --exact --group reference python <script>
```

The reference invocation applies to `golden/run_cli.py`, `golden/resize_reference.py`, `golden/perch_reference.py` and `eval/run_official.py`. At scaffold time, these paths did not contain runnable commands.

Run ONNX commands from `tools/`:

```sh
uv sync --locked --exact --group onnx
uv run --locked --exact --group onnx ruff check .
uv run --locked --exact --group onnx ruff format --check .
uv run --locked --exact --group onnx pyright
uv run --locked --exact --group onnx pytest
```

The existing ONNX group assignments remain:

| Scripts under `tools/`                                                                                                                         | Invocation from `tools/`                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `export/probe_onnx.py`, `export/speciesnet_crop.py`, `export/rtdetr_apache.py`, `export/fp16.py`, `export/publish_hf.py`                       | `uv run --locked --exact --group onnx python <script>` |
| `eval/ena24_sample.py`, `eval/run_onnx.py`, `eval/report.py`                                                                                   | `uv run --locked --exact --group onnx python <script>` |
| `sample/make_sample.py`, `sample/make_demo_card.py`, `data/countries.py`, `bench/upscale.py`, `local/perch_folder.py`, `design/blind_sheet.py` | `uv run --locked --exact --group onnx python <script>` |

Existing Node scripts run through npm. Group commands switch the shared `tools/.venv`; run them sequentially and do not use `--all-groups`.

## Verification

Verified on macOS 27.2 arm64 with Python 3.12.15 on 2026-11-05. Commands ran from `tools/`:

- `uv lock` exited 0: `Resolved 203 packages in 1.75s`. Neither megadetector nor ultralytics-yolov5 remains in the lockfile.
- `uv sync --locked --exact --group reference` exited 0: `Installed 106 packages in 285ms`, including speciesnet 5.0.6 and yolov5 7.0.11.
- `uv run --locked --exact --group reference python -c 'import speciesnet'` exited 0. Upstream yolov5 emitted a pkg_resources deprecation warning. Matplotlib fell back to a temporary cache and Fontconfig reported unwritable cache directories during the first import; these did not prevent import. No model inference is claimed by this import check.
- `uv sync --locked --exact --group onnx` exited 0. Each subsequent `uv run --locked --exact --group onnx` check exited 0: `ruff check .` ended with `All checks passed!`; `ruff format --check .` with `1 file already formatted`; `pyright` with `0 errors, 0 warnings, 0 informations`; `pytest` with `1 passed in 0.00s`. Pyright retains notices about directories absent at scaffold time.
- From the repository root, `npm run check` exited 0: `Test Files 2 passed (2)` and `Tests 3 passed (3)`. Biome retains its existing informational deprecation notice.

The shared virtual environment was left on the ONNX group after sequential verification. No package pins other than the directed removal, checker rules, or workflow steps changed. Remote CI and Linux installation remain unverified.

## Evaluation check dependencies (2026-11-11)

The full tools check exposed two undeclared check-time requirements: the existing
`data/countries.py` imports pycountry, and `test_perch_reference.py` imports
onnxruntime while testing its mocked sessions, including in the reference matrix
job. Pin pycountry 26.2.16 as a project dependency and make the already-pinned
onnxruntime 1.31.1 available in the dev group as well as the onnx group. This
preserves the exclusive reference/onnx groups and does not add megadetector.
