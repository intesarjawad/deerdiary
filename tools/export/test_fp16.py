import hashlib
import importlib
import json
from collections.abc import Callable
from pathlib import Path
from typing import Protocol

import numpy as np
import onnx
import pytest
from numpy.typing import NDArray
from onnx import TensorProto, helper

from export.fp16 import (
    Detection,
    align_float_casts,
    box_iou,
    check_agreement,
    decode_rows,
    preserve_float_outputs,
    write_perch_manifest,
)


class Evaluator(Protocol):
    def run(
        self, output_names: None, inputs: dict[str, NDArray[np.generic]]
    ) -> list[NDArray[np.generic]]: ...


def test_repairs_integer_to_float_cast_after_half_conversion() -> None:
    graph = helper.make_graph(
        [
            helper.make_node("Cast", ["sizes"], ["half_sizes"], to=TensorProto.FLOAT),
            helper.make_node("Cast", ["half_sizes"], ["output"], to=TensorProto.FLOAT),
        ],
        "converted_sizes",
        [helper.make_tensor_value_info("sizes", TensorProto.INT64, [1, 2])],
        [helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 2])],
        value_info=[helper.make_tensor_value_info("half_sizes", TensorProto.FLOAT16, [1, 2])],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    check_model: Callable[..., None] = importlib.import_module("onnx.checker").check_model
    evaluator_type: Callable[[onnx.ModelProto], Evaluator] = importlib.import_module(
        "onnx.reference"
    ).ReferenceEvaluator
    with pytest.raises(onnx.shape_inference.InferenceError, match="Inferred elem type differs"):
        check_model(model, full_check=True)
    align_float_casts(model)
    check_model(model, full_check=True)
    sizes = np.array([[1920, 1080]], dtype=np.int64)
    actual = evaluator_type(model).run(None, {"sizes": sizes})[0]
    np.testing.assert_array_equal(actual, sizes.astype(np.float32))
    assert model.graph.node[1].attribute[0].i == TensorProto.FLOAT


def test_preserves_casts_to_integers() -> None:
    check_model: Callable[..., None] = importlib.import_module("onnx.checker").check_model
    evaluator_type: Callable[[onnx.ModelProto], Evaluator] = importlib.import_module(
        "onnx.reference"
    ).ReferenceEvaluator
    graph = helper.make_graph(
        [helper.make_node("Cast", ["input"], ["output"], to=TensorProto.INT64)],
        "integer_output",
        [helper.make_tensor_value_info("input", TensorProto.FLOAT16, [1])],
        [helper.make_tensor_value_info("output", TensorProto.INT64, [1])],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    align_float_casts(model)
    check_model(model, full_check=True)
    actual = evaluator_type(model).run(None, {"input": np.array([2.5], dtype=np.float16)})[0]
    np.testing.assert_array_equal(actual, np.array([2], dtype=np.int64))


def test_restores_float_output_without_changing_internal_consumers() -> None:
    check_model: Callable[..., None] = importlib.import_module("onnx.checker").check_model
    evaluator_type: Callable[[onnx.ModelProto], Evaluator] = importlib.import_module(
        "onnx.reference"
    ).ReferenceEvaluator
    graph = helper.make_graph(
        [
            helper.make_node("Identity", ["input"], ["scores"]),
            helper.make_node("Cast", ["scores"], ["labels"], to=TensorProto.INT64),
        ],
        "mixed_outputs",
        [helper.make_tensor_value_info("input", TensorProto.FLOAT16, [1])],
        [
            helper.make_tensor_value_info("scores", TensorProto.FLOAT16, [1]),
            helper.make_tensor_value_info("labels", TensorProto.INT64, [1]),
        ],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    preserve_float_outputs(model, {"scores"})
    check_model(model, full_check=True)
    scores, labels = evaluator_type(model).run(None, {"input": np.array([2.5], dtype=np.float16)})
    assert scores.dtype == np.float32
    assert labels.dtype == np.int64
    np.testing.assert_array_equal(scores, np.array([2.5], dtype=np.float32))
    np.testing.assert_array_equal(labels, np.array([2], dtype=np.int64))


def test_box_iou_of_half_overlapping_squares() -> None:
    assert box_iou((0, 0, 2, 2), (1, 0, 3, 2)) == pytest.approx(1 / 3)
    assert box_iou((0, 0, 1, 1), (2, 2, 3, 3)) == 0


def test_decode_rows_scores_objectness_times_class_and_suppresses_within_a_class() -> None:
    rows = np.array(
        [
            [10, 10, 4, 4, 0.9, 0.8, 0.1, 0.0],
            [10.2, 10, 4, 4, 0.5, 0.9, 0.0, 0.0],
            [10, 10, 4, 4, 0.8, 0.0, 0.5, 0.0],
            [50, 50, 4, 4, 0.5, 0.01, 0.01, 0.01],
        ],
        dtype=np.float32,
    )
    kept = decode_rows(rows)
    assert [(d.category, round(d.conf, 4)) for d in kept] == [(0, 0.72), (1, 0.4)]
    assert kept[0].box == (8.0, 8.0, 12.0, 12.0)


def test_decode_rows_rejects_other_row_widths() -> None:
    with pytest.raises(ValueError, match="eight values"):
        decode_rows(np.zeros((2, 6), dtype=np.float32))


def test_agreement_accepts_small_differences_and_reports_the_lowest_iou() -> None:
    reference = [Detection(0, 0.90, (0, 0, 100, 100)), Detection(1, 0.50, (200, 0, 300, 100))]
    candidate = [Detection(1, 0.503, (200, 0, 300, 100)), Detection(0, 0.896, (0, 0, 100, 99))]
    assert check_agreement(reference, candidate, "pair.jpg") == pytest.approx(0.99)


@pytest.mark.parametrize(
    ("candidate", "message"),
    [
        ([], "count differs"),
        ([Detection(1, 0.9, (0, 0, 100, 100))], "no class 0"),
        ([Detection(0, 0.9, (0, 0, 100, 98))], "IoU"),
        ([Detection(0, 0.906, (0, 0, 100, 100))], "confidence"),
    ],
)
def test_agreement_rejects_each_kind_of_drift(candidate: list[Detection], message: str) -> None:
    with pytest.raises(ValueError, match=message):
        check_agreement([Detection(0, 0.9, (0, 0, 100, 100))], candidate, "drift.jpg")


def test_perch_manifest_entry_copies_upstream_provenance_and_measures_the_file(
    tmp_path: Path,
) -> None:
    exported = tmp_path / ".cache/exports/perch"
    exported.mkdir(parents=True)
    fp16 = exported / "perch.fp16.onnx"
    graph = helper.make_graph(
        [helper.make_node("Identity", ["inputs"], ["label"])],
        "perch_stub",
        [helper.make_tensor_value_info("inputs", TensorProto.FLOAT, ["batch", 4])],
        [helper.make_tensor_value_info("label", TensorProto.FLOAT, ["batch", 4])],
    )
    fp16.write_bytes(helper.make_model(graph).SerializeToString())
    provenance = {"url": "https://huggingface.co/example/perch", "commit": "a" * 40}
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "upstream": {"speciesnet_pypi": "5.0.6"},
                "files": [{"id": "perch", "licence": "Apache-2.0", "provenance": provenance}],
            }
        )
    )

    write_perch_manifest(fp16, manifest, tmp_path)

    written = json.loads(manifest.read_text())
    assert written["upstream"] == {"speciesnet_pypi": "5.0.6"}
    assert written["files"][0]["id"] == "perch"
    [entry] = written["local_perch_exports"]["files"]
    assert entry["id"] == "perch-fp16"
    assert entry["role"] == "perch"
    assert entry["precision"] == "fp16"
    assert entry["local_path"] == ".cache/exports/perch/perch.fp16.onnx"
    assert entry["licence"] == "Apache-2.0"
    assert entry["provenance"] == provenance
    assert entry["bytes"] == fp16.stat().st_size
    assert entry["sha256"] == hashlib.sha256(fp16.read_bytes()).hexdigest()
    assert entry["inputs"] == [
        {"name": "inputs", "dtype": "FLOAT", "shape": ["batch", 4], "dynamic_axes": [0]}
    ]
    assert entry["outputs"][0]["name"] == "label"
    assert written["local_perch_exports"]["publication"]["status"] == "pending-publication"
