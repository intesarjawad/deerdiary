import importlib
import json
from collections.abc import Callable
from typing import Protocol

import numpy as np
import onnx
from numpy.typing import NDArray

from export.fp16 import convert
from export.probe_onnx import MANIFEST_PATH, operators, tensor_io
from export.rtdetr_parity import compare
from export.rtdetr_source import (
    CHECKPOINT,
    CHECKPOINT_INTEGRITY,
    CHECKPOINT_URL,
    CONF_TOLERANCE,
    EXPORT_DIR,
    IMAGE_COUNT,
    IMAGE_SIZE,
    MIN_IOU,
    MODEL_NAME,
    OPSET,
    REFERENCE_DIR,
    SEED,
    Reference,
    model_path,
    require_disk_space,
)
from export.speciesnet_source import ROOT, integrity


class Session(Protocol):
    def run(
        self,
        output_names: list[str],
        input_feed: dict[str, NDArray[np.float32] | NDArray[np.int64]],
    ) -> list[NDArray[np.generic]]: ...


def validate_reference(record: Reference) -> None:
    if (
        record["pytorchwildlife"] != "1.3.1"
        or record["torch"] != "2.15.0"
        or record["device"] != "cpu"
        or record["seed"] != SEED
        or record["opset"] != OPSET
        or not record["postprocessing"]
        or len(record["cases"]) != IMAGE_COUNT + 2
        or len(set(record["cases"])) != IMAGE_COUNT + 2
        or len(record["images"]) != IMAGE_COUNT
        or set(record["cases"][:IMAGE_COUNT]) != set(record["images"])
        or record["cases"][IMAGE_COUNT:] != ["random-1", "random-2"]
        or len(record["fixtures"]) != len(record["cases"])
        or record["checkpoint"] != CHECKPOINT_INTEGRITY
        or not record["source_files"]
    ):
        raise ValueError("Incomplete CPU reference; rerun --prepare-reference")
    sources = [
        (ROOT / "tests/golden/upstream.provenance.json", record["golden_provenance"]),
        (CHECKPOINT, CHECKPOINT_INTEGRITY),
        (model_path("fp32"), record["fp32"]),
        *((ROOT / name, digest) for name, digest in record["images"].items()),
        *((REFERENCE_DIR / f"{i:03}.npz", digest) for i, digest in enumerate(record["fixtures"])),
    ]
    for path, expected in sources:
        if integrity(path) != expected:
            raise ValueError(f"Stale reference source: {path}; rerun --prepare-reference")


def infer(
    session: Session, images: NDArray[np.float32], sizes: NDArray[np.int64]
) -> tuple[NDArray[np.int64], NDArray[np.float32], NDArray[np.float32]]:
    names = ["labels", "boxes", "scores"]
    output = session.run(
        names,
        {
            "images": images,
            "orig_target_sizes": sizes,
        },
    )
    if len(output) != len(names) or [a.dtype for a in output] != [np.int64, np.float32, np.float32]:
        raise ValueError("Invalid detector output types")
    return (
        np.asarray(output[0], dtype=np.int64),
        np.asarray(output[1], dtype=np.float32),
        np.asarray(output[2], dtype=np.float32),
    )


def write_manifest() -> None:
    entries: list[dict[str, object]] = []
    for precision in ("fp32", "fp16"):
        path = model_path(precision)
        model = onnx.load_model_from_string(path.read_bytes())
        entries.append(
            {
                "id": f"mdv6-apa-rtdetr-c-{precision}",
                "role": "detector",
                "precision": precision,
                "local_path": str(path.relative_to(ROOT)),
                "licence": "Apache-2.0",
                "provenance": {
                    "url": CHECKPOINT_URL,
                    "record": "15398270",
                    "checkpoint_sha256": CHECKPOINT_INTEGRITY["sha256"],
                    "pytorchwildlife": "1.3.1",
                },
                **integrity(path),
                "inputs": [tensor_io(value) for value in model.graph.input],
                "outputs": [tensor_io(value) for value in model.graph.output],
                "op_histogram": dict(sorted(operators(model.graph).items())),
            }
        )
    manifest: dict[str, object] = json.loads(MANIFEST_PATH.read_text())
    manifest["local_detector_exports"] = {
        "publication": {
            "status": "pending-publication",
            "repo_id": "<owner>/deerdiary-mdv6-apa-rtdetr-c-onnx",
            "revision": None,
        },
        "selection": "pending detector evaluation and browser measurements; candidate only",
        "precision_policy": "retain both; browser support and fp16 parity remain unverified",
        "licence_note": "model zoo Apache-2.0; Zenodo collection CC-BY-4.0; see ADR 0002",
        "files": entries,
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n")


def check() -> None:
    require_disk_space()
    record: Reference = json.loads((REFERENCE_DIR / "reference.json").read_text())
    validate_reference(record)
    convert(model_path("fp32"), model_path("fp16"))
    session_type: Callable[..., Session] = importlib.import_module("onnxruntime").InferenceSession
    options = importlib.import_module("onnxruntime").SessionOptions()
    options.intra_op_num_threads = 1
    session = session_type(
        str(model_path("fp32")), sess_options=options, providers=["CPUExecutionProvider"]
    )
    results: list[dict[str, object]] = []
    minimum_iou = 1.0
    maximum_error = 0.0
    for index, name in enumerate(record["cases"]):
        with np.load(REFERENCE_DIR / f"{index:03}.npz", allow_pickle=False) as fixture:
            images: NDArray[np.float32] = fixture["images"]
            sizes: NDArray[np.int64] = fixture["orig_target_sizes"]
            labels: NDArray[np.int64] = fixture["labels"]
            boxes: NDArray[np.float32] = fixture["boxes"]
            scores: NDArray[np.float32] = fixture["scores"]
        if (
            images.shape != (1, 3, IMAGE_SIZE, IMAGE_SIZE)
            or images.dtype != np.float32
            or not np.isfinite(images).all()
            or np.any((images < 0) | (images > 1))
            or sizes.shape != (1, 2)
            or sizes.dtype != np.int64
            or np.any(sizes <= 0)
        ):
            raise ValueError(f"Invalid reference inputs: {name}")
        iou, error = compare((labels, boxes, scores), infer(session, images, sizes))
        minimum_iou = min(minimum_iou, iou)
        maximum_error = max(maximum_error, error)
        results.append({"case": name, "minimum_iou": iou, "max_conf_error": error})
    report = {
        **record,
        "fp32_minimum_iou": minimum_iou,
        "fp32_max_conf_error": maximum_error,
        "minimum_iou_required": MIN_IOU,
        "confidence_tolerance": CONF_TOLERANCE,
        "fp16": integrity(model_path("fp16")),
        "fp16_parity": "unverified; conversion and graph validation only",
        "results": results,
    }
    (EXPORT_DIR / "parity.json").write_text(json.dumps(report, indent=2) + "\n")
    (EXPORT_DIR / "README.md").write_text(
        f"# {MODEL_NAME} ONNX candidate\n\n"
        f"Checkpoint: {CHECKPOINT_URL}. PytorchWildlife 1.3.1, RT-DETRv2 r18vd, opset 17. "
        "EMA state is preferred, as in the package loader. Model zoo licence: Apache-2.0; "
        "Zenodo collection metadata says CC-BY-4.0. Resolve this discrepancy before publication. "
        "The package wrapper's MIT licence is in LICENSE-PytorchWildlife.\n\n"
        "Decode RGB with EXIF orientation, ignoring ICC profiles; PIL BILINEAR stretch to "
        "640x640, /255 float32 NCHW [1,3,640,640]. orig_target_sizes is int64 [1,2] "
        "in [width,height] order after orientation. labels is int64 [1,300], boxes is "
        "float32 [1,300,4] in original-image xyxy pixels, scores is float32 [1,300]. "
        "Classes: 0 animal, 1 person, 2 vehicle. The graph applies sigmoid and top-300 "
        "over query/class pairs, with no NMS, threshold or coordinate clipping. "
        "Normalize x by width and y by height when converting boxes for the app.\n\n"
        "Both precisions retain float32 image/box/score I/O and int64 sizes/labels. "
        "parity.json records CPU fp32 parity on all 300 queries for 16 golden images "
        "and two seeded random inputs. fp16 has graph validation only; numerical parity, "
        "browser execution and detector selection remain pending. "
        "Publication placeholder: <owner>/deerdiary-mdv6-apa-rtdetr-c-onnx.\n"
    )
    write_manifest()
    print(
        f"PASS: {IMAGE_COUNT} golden images, 2 random inputs, 300 queries each; "
        f"fp32 min IoU {minimum_iou:.9g} >= {MIN_IOU}; "
        f"max conf error {maximum_error:.9g} <= {CONF_TOLERANCE}; fp16 written and checked"
    )
