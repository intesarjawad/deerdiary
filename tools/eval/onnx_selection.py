import argparse
import importlib
import json
from collections.abc import Callable
from pathlib import Path
from tempfile import gettempdir
from typing import NotRequired, Protocol, TypedDict

import numpy as np
from numpy.typing import NDArray

from eval.detector_scores import animal_score
from eval.selection import SEED, compare_models
from export.probe_onnx import pinned_source
from export.speciesnet_source import ROOT, Integrity, integrity

MINIMUM_ENA_BLANKS = 200
CCT_BLANKS = 300


class Case(TypedDict):
    path: str
    dataset: str
    animal: bool
    small: bool
    blank: bool
    tensor: str
    tensor_integrity: Integrity


class Dataset(TypedDict):
    n: int
    seed: int
    ena_blank_count: int
    cases: list[Case]
    preprocessing: str


class Model(Integrity):
    id: str
    url: NotRequired[str]
    local_path: NotRequired[str]


class Exports(TypedDict):
    files: list[Model]


class Manifest(TypedDict):
    files: list[Model]
    local_detector_exports: Exports


class Session(Protocol):
    def run(
        self, output_names: None, input_feed: dict[str, NDArray[np.generic]]
    ) -> list[NDArray[np.generic]]: ...


def model_file(model: Model, cache: Path) -> Path:
    if "local_path" in model:
        path = ROOT / model["local_path"]
    elif "url" in model:
        repository, revision, filename = pinned_source(model["url"])
        path = (
            cache / f"models--{repository.replace('/', '--')}" / "snapshots" / revision / filename
        )
    else:
        raise ValueError("Model needs a local path or pinned URL")
    if integrity(path) != {"bytes": model["bytes"], "sha256": model["sha256"]}:
        raise ValueError(f"Model integrity mismatch: {path}")
    return path


def validate_dataset(dataset: Dataset, n: int) -> int:
    if dataset["n"] != n or dataset["seed"] != SEED:
        raise ValueError("Prepared dataset n or seed differs; rerun prepare_selection.py")
    cases = dataset["cases"]
    if len({(case["dataset"], case["path"]) for case in cases}) != len(cases):
        raise ValueError("Duplicate dataset images")
    ena = [case for case in cases if case["dataset"] == "ENA24"]
    cct = [case for case in cases if case["dataset"] == "CCT"]
    if len(ena) != n or len(ena) + len(cct) != len(cases):
        raise ValueError("Dataset must contain n ENA24 images plus optional CCT blanks")
    if dataset["ena_blank_count"] != sum(case["blank"] for case in ena):
        raise ValueError("ENA24 blank count mismatch")
    if any(not case["blank"] or case["animal"] or case["small"] for case in cct):
        raise ValueError("CCT images may only supply ground-truth blanks")
    if dataset["ena_blank_count"] < MINIMUM_ENA_BLANKS and len(cct) != CCT_BLANKS:
        raise ValueError("Fewer than 200 ENA24 blanks requires exactly 300 CCT blanks")
    return len(cct)


def infer_dataset(session: Session, name: str, cases: list[Case], directory: Path) -> list[float]:
    values: list[float] = []
    for case in cases:
        path = (directory / case["tensor"]).resolve()
        if not path.is_relative_to(directory.resolve()):
            raise ValueError("Tensor path escapes dataset directory")
        if integrity(path) != case["tensor_integrity"]:
            raise ValueError(f"Stale image tensor: {path}")
        with np.load(path, allow_pickle=False) as fixture:
            images: NDArray[np.float32] = fixture[name]
            side = {"mdv5a": 1280, "sorrel": 960, "rtdetr": 640}[name]
            if (
                images.dtype != np.float32
                or images.shape != (1, 3, side, side)
                or not np.isfinite(images).all()
                or np.any((images < 0) | (images > 1))
            ):
                raise ValueError(f"Invalid tensor: {path}, {name}")
            feeds: dict[str, NDArray[np.generic]] = {"images": images}
            if name == "rtdetr":
                sizes: NDArray[np.int64] = fixture["orig_target_sizes"]
                if sizes.dtype != np.int64 or sizes.shape != (1, 2) or np.any(sizes <= 0):
                    raise ValueError(f"Invalid original sizes: {path}")
                feeds["orig_target_sizes"] = sizes
            values.append(animal_score(name, session.run(None, feeds)))
    return values


def main() -> None:
    parser = argparse.ArgumentParser(description="Matched-FDR comparison of local ONNX detectors")
    parser.add_argument("--models", default="mdv5a,sorrel,rtdetr")
    parser.add_argument("--n", type=int, default=1000)
    parser.add_argument(
        "--data", type=Path, default=ROOT / ".cache/detector-selection/dataset.json"
    )
    parser.add_argument("--model-cache", type=Path, default=Path(gettempdir()) / "deerdiary-models")
    parser.add_argument("--out", type=Path, default=Path("eval/results/detector_selection.json"))
    args = parser.parse_args()
    if args.models.split(",") != ["mdv5a", "sorrel", "rtdetr"] or args.n < 1:
        parser.error("Use --models mdv5a,sorrel,rtdetr and a positive n")
    dataset: Dataset = json.loads(args.data.read_text())
    cct_count = validate_dataset(dataset, args.n)
    cases = dataset["cases"]
    manifest: Manifest = json.loads((ROOT / "models/manifest.json").read_text())
    models = {model["id"]: model for model in manifest["files"]}
    rtdetr = next(
        model
        for model in manifest["local_detector_exports"]["files"]
        if model["id"] == "mdv6-apa-rtdetr-c-fp32"
    )
    runtime = importlib.import_module("onnxruntime")
    runtime.disable_telemetry_events()
    session_type: Callable[..., Session] = runtime.InferenceSession
    options = runtime.SessionOptions()
    options.intra_op_num_threads = 1
    scores: dict[str, list[float]] = {}
    sources: dict[str, object] = {}
    for name, model in (
        ("mdv5a", models["mdv5a"]),
        ("sorrel", models["sorrel"]),
        ("rtdetr", rtdetr),
    ):
        path = model_file(model, args.model_cache)
        session = session_type(str(path), sess_options=options, providers=["CPUExecutionProvider"])
        scores[name] = infer_dataset(session, name, cases, args.data.parent)
        sources[name] = integrity(path)
        del session
    report = compare_models(
        scores,
        [case["animal"] for case in cases],
        [case["small"] for case in cases],
        [case["blank"] for case in cases],
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(
            {
                "dataset": dataset,
                "dataset_integrity": integrity(args.data),
                "model_integrity": sources,
                "scores": scores,
                "comparison": report,
                "caveats": [
                    "MegaDetector-family training may include ENA24 and CCT; "
                    "absolute recall is optimistic.",
                    "Ensemble thresholds remain calibrated to MDv5a; "
                    "matched thresholds are evaluation only.",
                    "MDv5a uses square padding for its fixed export; "
                    "this does not establish official pipeline parity.",
                    "RT-DETR comparison uses fp32; "
                    "fp16 numerical agreement is measured separately in the browser.",
                ],
            },
            indent=2,
            allow_nan=False,
        )
        + "\n"
    )
    print(f"Wrote {args.out}: {args.n} ENA24 images, {cct_count} CCT blanks, 1000 paired resamples")


if __name__ == "__main__":
    main()
