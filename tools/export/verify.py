import importlib
import json
from collections.abc import Callable
from pathlib import Path
from typing import NotRequired, Protocol, TypedDict

import numpy as np
import onnx
from numpy.typing import NDArray

from export.fp16 import convert
from export.probe_onnx import MANIFEST_PATH, tensor_io
from export.speciesnet_source import (
    EXPORT_DIR,
    FP32_TOLERANCE,
    IMAGE_COUNT,
    IMAGE_SIZE,
    LABEL_COUNT,
    MODEL_DIR,
    RAW_PATH,
    REFERENCE_DIR,
    ROOT,
    Reference,
    integrity,
    read_info,
)


class Session(Protocol):
    def run(
        self, output_names: list[str], input_feed: dict[str, NDArray[np.float32]]
    ) -> list[NDArray[np.float32]]: ...


class LocalExports(TypedDict):
    publication: dict[str, object]
    precision_policy: str
    files: list[dict[str, object]]


class Manifest(TypedDict):
    local_exports: NotRequired[LocalExports]


def validate_reference(record: Reference, fp32: Path) -> None:
    if (
        record["speciesnet_pypi"] != "5.0.6"
        or record["device"] != "cpu"
        or record["golden_images"] != IMAGE_COUNT
        or record["golden_crops"] <= 0
        or len(record["cases"]) != record["golden_crops"] + 2
        or len(record["fixtures"]) != len(record["cases"])
        or len(record["images"]) != IMAGE_COUNT
    ):
        raise ValueError("Incomplete CPU reference; rerun --prepare-reference")
    info = read_info()
    sources = [
        (RAW_PATH, record["raw_golden"]),
        (MODEL_DIR / info["classifier"], record["checkpoint"]),
        (fp32, record["fp32"]),
        *((ROOT / path, digest) for path, digest in record["images"].items()),
        *((REFERENCE_DIR / f"{i:03}.npz", digest) for i, digest in enumerate(record["fixtures"])),
    ]
    for path, expected in sources:
        if integrity(path) != expected:
            raise ValueError(f"Stale reference source: {path}; rerun --prepare-reference")


def logit_error(reference: NDArray[np.float32], actual: NDArray[np.float32], name: str) -> float:
    if actual.shape != reference.shape or not np.isfinite(actual).all():
        raise ValueError(f"Invalid ONNX logits: {name}")
    error = float(np.max(np.abs(reference - actual)))
    if error >= FP32_TOLERANCE:
        raise ValueError(f"fp32 parity failed: {name}, max abs {error} >= {FP32_TOLERANCE}")
    return error


def write_manifest(fp32: Path, fp16: Path) -> None:
    info = read_info()
    entries: list[dict[str, object]] = []
    for path, role, precision in [
        (fp32, "classifier", "fp32"),
        (fp16, "classifier", "fp16"),
        (EXPORT_DIR / info["classifier_labels"], "classifier_labels", None),
        (EXPORT_DIR / info["taxonomy"], "taxonomy", None),
        (EXPORT_DIR / info["geofence"], "geofence", None),
    ]:
        entry: dict[str, object] = {
            "id": f"speciesnet-v403a-{precision or role}",
            "role": role,
            "local_path": str(path.relative_to(ROOT)),
            "licence": "Apache-2.0",
            "provenance": {
                "url": "https://www.kaggle.com/models/google/speciesnet/pyTorch/v4.0.3a/1",
                "version": "1",
            },
            **integrity(path),
        }
        if precision:
            model = onnx.load_model_from_string(path.read_bytes())
            entry.update(
                {
                    "precision": precision,
                    "inputs": [tensor_io(value) for value in model.graph.input],
                    "outputs": [tensor_io(value) for value in model.graph.output],
                }
            )
        elif integrity(path) != integrity(MODEL_DIR / path.name):
            raise ValueError(f"Copied asset disagrees with upstream: {path}")
        entries.append(entry)
    manifest: Manifest = json.loads(MANIFEST_PATH.read_text())
    policy = "pending ADR 0003 browser run; retain both artifacts"
    previous = manifest.get("local_exports")
    if previous is not None:
        old_hashes = {str(entry["id"]): entry["sha256"] for entry in previous["files"]}
        new_hashes = {str(entry["id"]): entry["sha256"] for entry in entries}
        if old_hashes == new_hashes:
            policy = previous["precision_policy"]
    manifest["local_exports"] = {
        "publication": {
            "status": "pending-publication",
            "repo_id": "<owner>/deerdiary-speciesnet-v4.0.3a-crop-onnx",
            "revision": None,
        },
        "precision_policy": policy,
        "files": entries,
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n")


def check() -> None:
    fp32 = EXPORT_DIR / "speciesnet-v4.0.3a-crop.fp32.onnx"
    fp16 = EXPORT_DIR / "speciesnet-v4.0.3a-crop.fp16.onnx"
    record: Reference = json.loads((REFERENCE_DIR / "reference.json").read_text())
    validate_reference(record, fp32)
    convert(fp32, fp16)
    session_type: Callable[..., Session] = importlib.import_module("onnxruntime").InferenceSession
    sessions = [
        session_type(str(path), providers=["CPUExecutionProvider"]) for path in (fp32, fp16)
    ]
    results: list[dict[str, object]] = []
    max_error = 0.0
    for index, name in enumerate(record["cases"]):
        with np.load(REFERENCE_DIR / f"{index:03}.npz", allow_pickle=False) as fixture:
            values: NDArray[np.float32] = fixture["image"]
            expected: NDArray[np.float32] = fixture["logits"]
        if (
            values.shape[1:] != (IMAGE_SIZE, IMAGE_SIZE, 3)
            or expected.shape != (values.shape[0], LABEL_COUNT)
            or not np.isfinite(expected).all()
        ):
            raise ValueError(f"Invalid reference tensor: {name}")
        actual, half = [session.run(["logits"], {"image": values})[0] for session in sessions]
        error = logit_error(expected, actual, name)
        if half.shape != expected.shape or not np.isfinite(half).all():
            raise ValueError(f"Invalid fp16 logits: {name}")
        if not np.array_equal(np.argmax(expected, axis=1), np.argmax(half, axis=1)):
            raise ValueError(f"fp16 top-1 differs from PyTorch: {name}")
        max_error = max(max_error, error)
        results.append({"case": name, "fp32_max_abs": error, "fp16_top1_equal": True})
    report = {
        **record,
        "fp32_max_abs": max_error,
        "fp32_tolerance": FP32_TOLERANCE,
        "fp16_top1_equal": True,
        "fp16": integrity(fp16),
        "results": results,
    }
    (EXPORT_DIR / "parity.json").write_text(json.dumps(report, indent=2) + "\n")
    write_manifest(fp32, fp16)
    print(
        f"PASS: {IMAGE_COUNT} golden images, {record['golden_crops']} CLI crops, 2 random batches; "
        f"fp32 max abs {max_error:.9g} < {FP32_TOLERANCE}; fp16 top-1 identical in every case"
    )
