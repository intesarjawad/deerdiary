import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import NotRequired, TypedDict

ROOT = Path(__file__).resolve().parents[2]
GOLDEN = ROOT / "tests/golden"
IMAGE_COUNT = 16
TOP_K = 5


class Classifications(TypedDict):
    classes: list[str]
    scores: list[float]


class ProcessedClassification(TypedDict):
    source: str


class Detection(TypedDict):
    bbox: list[float]
    conf: float
    raw_classifications: NotRequired[Classifications]
    processed_classification: NotRequired[ProcessedClassification]


class Prediction(TypedDict):
    filepath: str
    detections: list[Detection]
    failures: NotRequired[list[str]]


class Predictions(TypedDict):
    info: dict[str, str]
    predictions: list[Prediction]


def load_predictions(path: Path) -> Predictions:
    data: Predictions = json.loads(path.read_text())
    if len(data["predictions"]) != IMAGE_COUNT:
        raise ValueError(f"Expected {IMAGE_COUNT} predictions in {path}")
    for prediction in data["predictions"]:
        if prediction.get("failures"):
            raise ValueError(f"Reference inference failed: {prediction}")
    return data


def merge_raw(detector: Predictions, classifier: Predictions) -> Predictions:
    by_file = {prediction["filepath"]: prediction for prediction in classifier["predictions"]}
    if set(by_file) != {prediction["filepath"] for prediction in detector["predictions"]}:
        raise ValueError("Detector and classifier file sets disagree")
    for prediction in detector["predictions"]:
        classified = by_file[prediction["filepath"]]["detections"]
        if len(classified) != len(prediction["detections"]):
            raise ValueError(f"Detection counts disagree: {prediction['filepath']}")
        for detection, result in zip(prediction["detections"], classified, strict=True):
            if detection["bbox"] != result["bbox"] or detection["conf"] != result["conf"]:
                raise ValueError(f"Detection geometry disagrees: {prediction['filepath']}")
            raw = result.get("raw_classifications")
            if raw is not None:
                if len(raw["classes"]) != TOP_K or len(raw["scores"]) != TOP_K:
                    raise ValueError("Every classified detection must have five raw classes")
                detection["raw_classifications"] = raw
    return detector


def validate_ensemble_capture(raw: Predictions, combined: Predictions) -> None:
    expected = {image["filepath"]: image["detections"] for image in raw["predictions"]}
    actual = {
        image["filepath"]: [
            {key: value for key, value in detection.items() if key != "processed_classification"}
            for detection in image["detections"]
        ]
        for image in combined["predictions"]
    }
    if actual != expected:
        raise ValueError("Ensemble reference does not match the serialized raw capture")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Regenerate the five CLI runs and serialized-box ensemble references."
    )
    parser.add_argument("--work-dir", type=Path, default=ROOT / ".cache/deerdiary-cli")
    args = parser.parse_args()
    images = GOLDEN / "upstream"
    if len(list(images.glob("*.jpg"))) != IMAGE_COUNT:
        raise ValueError(f"Place all {IMAGE_COUNT} upstream test_data JPEGs in {images}")
    args.work_dir.mkdir(parents=True, exist_ok=True)
    env = {
        **os.environ,
        "KAGGLEHUB_CACHE": str(ROOT / ".cache/kagglehub"),
        "MPLCONFIGDIR": str(ROOT / ".cache/matplotlib"),
        "YOLO_CONFIG_DIR": str(ROOT / ".cache/yolo"),
        "XDG_CACHE_HOME": str(ROOT / ".cache"),
        "OMP_NUM_THREADS": "1",
    }
    common = [
        sys.executable,
        "-m",
        "speciesnet.scripts.run_model",
        "--folders",
        "tests/golden/upstream",
        "--max_classifications_per_image",
        str(TOP_K),
        "--max_classifications_per_detection",
        str(TOP_K),
        "--batch_size",
        "1",
        "--noprogress_bars",
        "--ignore_existing_predictions",
    ]
    modes: list[tuple[Path, list[str]]] = [
        (GOLDEN / "speciesnet_cli.none.json", []),
        (GOLDEN / "speciesnet_cli.usa.json", ["--country", "USA"]),
        (GOLDEN / "speciesnet_cli.gbr.json", ["--country", "GBR"]),
        (args.work_dir / "detections.json", ["--detector_only"]),
        (
            args.work_dir / "classifications.json",
            ["--classifier_only", "--detections_json", str(args.work_dir / "detections.json")],
        ),
    ]
    for destination, flags in modes:
        subprocess.run(
            [*common, *flags, "--predictions_json", str(destination)],
            cwd=ROOT,
            env=env,
            check=True,
        )
        load_predictions(destination)
    raw = merge_raw(
        load_predictions(args.work_dir / "detections.json"),
        load_predictions(args.work_dir / "classifications.json"),
    )
    (GOLDEN / "speciesnet_cli.raw.json").write_text(json.dumps(raw, indent=2) + "\n")
    # Saved boxes are rounded by SpeciesNet; ensemble the saved crop inputs,
    # not the unrounded boxes used during uninterrupted full inference.
    for country, flags in [
        ("none", []),
        ("usa", ["--country", "USA"]),
        ("gbr", ["--country", "GBR"]),
    ]:
        destination = GOLDEN / f"speciesnet_cli.{country}.json"
        subprocess.run(
            [
                *common,
                "--ensemble_only",
                "--detections_json",
                str(args.work_dir / "detections.json"),
                "--classifications_json",
                str(args.work_dir / "classifications.json"),
                *flags,
                "--predictions_json",
                str(destination),
            ],
            cwd=ROOT,
            env=env,
            check=True,
        )
        validate_ensemble_capture(raw, load_predictions(destination))
    gbr = load_predictions(GOLDEN / "speciesnet_cli.gbr.json")
    bear = next(
        p for p in gbr["predictions"] if Path(p["filepath"]).name == "american_black_bear.jpg"
    )
    if not any(
        d.get("processed_classification", {}).get("source", "").startswith("classifier+geofence+")
        for d in bear["detections"]
    ):
        raise ValueError("GBR black bear must exercise classifier+geofence+")
    print(
        "Validated five CLI runs and three serialized-box ensemble references "
        f"over {IMAGE_COUNT} images"
    )


if __name__ == "__main__":
    main()
