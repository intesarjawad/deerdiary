import argparse
import importlib
import json
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import NamedTuple, Protocol, cast

import numpy as np
import onnx
from numpy.typing import NDArray
from onnx import ModelProto
from PIL import Image, ImageOps

DETECTION_THRESHOLD = 0.01
NMS_IOU = 0.45
MAX_DETECTIONS = 300
MINIMUM_IOU = 0.99
MAXIMUM_CONFIDENCE_ERROR = 0.005
DETECTOR_SIDE = 1280
ROW_RANK = 2
ROW_WIDTH = 8


def align_float_casts(model: ModelProto) -> None:
    # Converter 1.16.0 changes value_info but leaves pre-existing Cast(to=FLOAT) attributes.
    for graph in [model.graph, *nested_graphs(model.graph)]:
        half_values = {
            value.name
            for value in graph.value_info
            if value.type.tensor_type.elem_type == onnx.TensorProto.FLOAT16
        }
        for node in graph.node:
            if node.op_type == "Cast" and node.output[0] in half_values:
                for attribute in node.attribute:
                    if attribute.name == "to" and attribute.i == onnx.TensorProto.FLOAT:
                        attribute.i = onnx.TensorProto.FLOAT16


def nested_graphs(graph: onnx.GraphProto) -> list[onnx.GraphProto]:
    result: list[onnx.GraphProto] = []
    for node in graph.node:
        for attribute in node.attribute:
            children = (
                [attribute.g] if attribute.type == onnx.AttributeProto.GRAPH else attribute.graphs
            )
            for child in children:
                result.extend([child, *nested_graphs(child)])
    return result


def preserve_float_outputs(model: ModelProto, names: set[str]) -> None:
    # Blocked operators can still acquire fp16 graph outputs despite keep_io_types=True.
    for output in model.graph.output:
        if output.name not in names or output.type.tensor_type.elem_type == onnx.TensorProto.FLOAT:
            continue
        if output.type.tensor_type.elem_type != onnx.TensorProto.FLOAT16:
            raise ValueError(f"Unexpected converted output type: {output.name}")
        original_name = output.name
        internal_name = f"{original_name}_fp16_output"
        for node in model.graph.node:
            for connections in (node.input, node.output):
                for index, name in enumerate(connections):
                    if name == original_name:
                        connections[index] = internal_name
        for value in model.graph.value_info:
            if value.name == original_name:
                value.name = internal_name
        output.type.tensor_type.elem_type = onnx.TensorProto.FLOAT
        model.graph.node.append(
            onnx.helper.make_node(
                "Cast",
                [internal_name],
                [original_name],
                to=onnx.TensorProto.FLOAT,
                name=f"{original_name}_restore_float32",
            )
        )


def convert(source: Path, destination: Path) -> None:
    converter: Callable[..., ModelProto] = importlib.import_module(
        "onnxconverter_common.float16"
    ).convert_float_to_float16
    original = onnx.load_model_from_string(source.read_bytes())
    float_outputs = {
        value.name
        for value in original.graph.output
        if value.type.tensor_type.elem_type == onnx.TensorProto.FLOAT
    }
    original_io = [
        (value.name, value.type.tensor_type.elem_type)
        for value in [*original.graph.input, *original.graph.output]
    ]
    model = converter(original, keep_io_types=True)
    align_float_casts(model)
    preserve_float_outputs(model, float_outputs)
    converted_io = [
        (value.name, value.type.tensor_type.elem_type)
        for value in [*model.graph.input, *model.graph.output]
    ]
    if converted_io != original_io:
        raise ValueError("fp16 conversion changed the model input/output types")
    check_model: Callable[..., None] = importlib.import_module("onnx.checker").check_model
    check_model(model, full_check=True)
    destination.write_bytes(model.SerializeToString())


def write_perch_manifest(fp16: Path, manifest_path: Path, root: Path) -> None:
    """Records the fp16 Perch graph beside the pinned upstream entry it was converted from."""
    tensor_io: Callable[[object], dict[str, object]] = importlib.import_module(
        "export.probe_onnx"
    ).tensor_io
    integrity: Callable[[Path], dict[str, object]] = importlib.import_module(
        "export.speciesnet_source"
    ).integrity
    manifest = cast(dict[str, object], json.loads(manifest_path.read_text()))
    upstream = next(
        entry
        for entry in cast(list[dict[str, object]], manifest["files"])
        if entry["id"] == "perch"
    )
    model = onnx.load_model_from_string(fp16.read_bytes())
    manifest["local_perch_exports"] = {
        "publication": {
            "status": "pending-publication",
            "repo_id": "<owner>/deerdiary-perch-v2-no-dft-onnx",
            "revision": None,
        },
        "precision_policy": (
            "fp16 of the DFT-free graph, converted with keep_io_types; "
            "golden/perch_reference.py --check enforces top-1 agreement with fp32"
        ),
        "files": [
            {
                "id": "perch-fp16",
                "role": "perch",
                "precision": "fp16",
                "local_path": str(fp16.relative_to(root)),
                "licence": upstream["licence"],
                "provenance": upstream["provenance"],
                **integrity(fp16),
                "inputs": [tensor_io(value) for value in model.graph.input],
                "outputs": [tensor_io(value) for value in model.graph.output],
            }
        ],
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")


def export_perch(source: Path, destination: Path) -> None:
    """Converts the DFT-free Perch graph, then records it only if the golden clips agree."""
    reference = importlib.import_module("golden.perch_reference")
    probe = importlib.import_module("export.probe_onnx")
    convert(source, destination)
    check: Callable[[Path, Path, Path], object] = reference.check
    check(source, destination, reference.CLIPS_DIR)
    write_perch_manifest(destination, probe.MANIFEST_PATH, reference.ROOT)


class Detection(NamedTuple):
    category: int
    conf: float
    box: tuple[float, float, float, float]


class Session(Protocol):
    def run(
        self, output_names: None, input_feed: dict[str, NDArray[np.float32]]
    ) -> list[NDArray[np.float32]]: ...


def box_iou(a: Sequence[float], b: Sequence[float]) -> float:
    overlap = max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(
        0.0, min(a[3], b[3]) - max(a[1], b[1])
    )
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - overlap
    return overlap / union if union > 0 else 0.0


def decode_rows(rows: NDArray[np.float32]) -> list[Detection]:
    """YOLOv5 rows are cx/cy/w/h/objectness plus three class probabilities; NMS is per class."""
    if rows.ndim != ROW_RANK or rows.shape[1] != ROW_WIDTH or not np.isfinite(rows).all():
        raise ValueError("Expected finite detector rows of eight values")
    candidates: list[Detection] = []
    for x, y, w, h, objectness, *probabilities in rows.tolist():
        category = int(np.argmax(probabilities))
        conf = objectness * probabilities[category]
        if conf > DETECTION_THRESHOLD:
            candidates.append(
                Detection(category, conf, (x - w / 2, y - h / 2, x + w / 2, y + h / 2))
            )
    kept: list[Detection] = []
    for candidate in sorted(candidates, key=lambda d: d.conf, reverse=True):
        if all(
            other.category != candidate.category or box_iou(other.box, candidate.box) <= NMS_IOU
            for other in kept
        ):
            kept.append(candidate)
        if len(kept) == MAX_DETECTIONS:
            break
    return kept


def check_agreement(
    reference: Sequence[Detection],
    candidate: Sequence[Detection],
    label: str,
    minimum_iou: float = MINIMUM_IOU,
    maximum_confidence_error: float = MAXIMUM_CONFIDENCE_ERROR,
) -> float:
    """Pairs detections one to one within a class and returns the lowest IoU among the pairs."""
    if len(reference) != len(candidate):
        raise ValueError(
            f"fp16 detection count differs on {label}: {len(reference)} vs {len(candidate)}"
        )
    unmatched = list(candidate)
    lowest = 1.0
    for expected in sorted(reference, key=lambda d: d.conf, reverse=True):
        options = [d for d in unmatched if d.category == expected.category]
        if not options:
            raise ValueError(f"fp16 has no class {expected.category} detection on {label}")
        best = max(options, key=lambda d: box_iou(d.box, expected.box))
        unmatched.remove(best)
        iou = box_iou(best.box, expected.box)
        lowest = min(lowest, iou)
        if iou < minimum_iou:
            raise ValueError(f"fp16 box IoU {iou:.4f} is below {minimum_iou} on {label}")
        if abs(best.conf - expected.conf) > maximum_confidence_error:
            raise ValueError(
                f"fp16 confidence differs by {abs(best.conf - expected.conf):.4f} on {label}"
            )
    return lowest


def detect(session: Session, image: Image.Image) -> list[Detection]:
    letterbox: Callable[[Image.Image, int], NDArray[np.float32]] = importlib.import_module(
        "eval.prepare_selection"
    ).letterbox
    return decode_rows(session.run(None, {"images": letterbox(image, DETECTOR_SIDE)})[0][0])


def verify(fp32: Path, fp16: Path, images: Sequence[Path]) -> float:
    """Runs both graphs on every image and returns the lowest box IoU between them."""
    runtime = importlib.import_module("onnxruntime")
    sessions: list[Session] = [
        runtime.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        for path in (fp32, fp16)
    ]
    lowest = 1.0
    for path in images:
        with Image.open(path) as opened:
            image = (ImageOps.exif_transpose(opened) or opened).convert("RGB")
        lowest = min(
            lowest,
            check_agreement(detect(sessions[0], image), detect(sessions[1], image), path.name),
        )
    return lowest


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert a detector to fp16 and check it.")
    commands = parser.add_subparsers(dest="command", required=True)
    convert_command = commands.add_parser("convert")
    convert_command.add_argument("source", type=Path)
    convert_command.add_argument("destination", type=Path)
    perch_command = commands.add_parser("perch")
    perch_command.add_argument("source", type=Path)
    perch_command.add_argument("destination", type=Path)
    verify_command = commands.add_parser("verify")
    verify_command.add_argument("fp32", type=Path)
    verify_command.add_argument("fp16", type=Path)
    verify_command.add_argument("images", type=Path, nargs="+")
    arguments = parser.parse_args()
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    if arguments.command == "convert":
        convert(arguments.source, arguments.destination)
    elif arguments.command == "perch":
        export_perch(arguments.source, arguments.destination)
        print(f"PASS: {arguments.destination} agrees with fp32 and is recorded in the manifest")
    else:
        lowest = verify(arguments.fp32, arguments.fp16, arguments.images)
        print(f"PASS: {len(arguments.images)} images, lowest fp16 box IoU {lowest:.6f}")


if __name__ == "__main__":
    main()
