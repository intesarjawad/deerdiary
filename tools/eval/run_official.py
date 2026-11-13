"""Run the pinned official SpeciesNet CLI using existing local weights."""

import argparse
import hashlib
import importlib.metadata
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import NotRequired, TypedDict

ROOT = Path(__file__).resolve().parents[2]


class PredictionPath(TypedDict):
    filepath: str
    failures: NotRequired[list[str]]


class BatchPaths(TypedDict):
    predictions: list[PredictionPath]


def normalize_paths(path: Path, image_root: Path) -> int:
    batch: BatchPaths = json.loads(path.read_text())
    expected = {
        image.relative_to(image_root).as_posix()
        for image in image_root.rglob("*")
        if image.suffix.lower() in {".jpg", ".jpeg"}
    }
    names: list[str] = []
    for prediction in batch["predictions"]:
        if prediction.get("failures"):
            raise ValueError(f"Official inference failed: {prediction}")
        source = Path(prediction["filepath"])
        name = (
            source.relative_to(image_root).as_posix() if source.is_absolute() else source.as_posix()
        )
        prediction["filepath"] = name
        names.append(name)
    if not expected or set(names) != expected or len(names) != len(expected):
        raise ValueError("Official predictions must cover every input image exactly once")
    path.write_text(json.dumps(batch, indent=2) + "\n")
    return len(names)


def prepare_resume(path: Path, image_root: Path) -> int:
    batch: BatchPaths = json.loads(path.read_text())
    if "predictions" not in batch:
        raise ValueError("Resume needs an unpacked CLI checkpoint; omit --resume for a fresh run")
    for prediction in batch["predictions"]:
        source = Path(prediction["filepath"])
        if not source.is_absolute():
            prediction["filepath"] = str((image_root / source).resolve())
    path.write_text(json.dumps(batch, indent=2) + "\n")
    return sum(not prediction.get("failures") for prediction in batch["predictions"])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--resume", action="store_true", help="Reuse completed official predictions"
    )
    parser.add_argument("--files", type=Path, default=ROOT / "tools/eval/data/eval_2000")
    parser.add_argument("--out", type=Path, default=ROOT / "tools/eval/results/official_usa.json")
    parser.add_argument(
        "--model-dir",
        type=Path,
        default=ROOT / (".cache/kagglehub/models/google/speciesnet/pyTorch/v4.0.3a/1"),
    )
    args = parser.parse_args()
    info: dict[str, str] = json.loads((args.model_dir / "info.json").read_text())
    weights: dict[str, dict[str, str | int]] = {}
    for role in ("classifier", "detector"):
        name = info[role]
        if name.startswith("https://"):
            name = name.replace(":", "_").replace("/", "_")
        path = args.model_dir / name
        if not path.is_file():
            raise ValueError(f"Required cached {role} weights are missing: {path}")
        with path.open("rb") as stream:
            weights[role] = {
                "file": path.name,
                "bytes": path.stat().st_size,
                "sha256": hashlib.file_digest(stream, "sha256").hexdigest(),
            }
    command = [
        sys.executable,
        "-m",
        "speciesnet.scripts.run_model",
        "--model",
        str(args.model_dir.resolve()),
        "--folders",
        str(args.files.resolve()),
        "--country",
        "USA",
        "--max_classifications_per_image",
        "5",
        "--max_classifications_per_detection",
        "5",
        "--batch_size",
        "1",
        "--progress_bars",
        "--noignore_existing_predictions" if args.resume else "--ignore_existing_predictions",
        "--predictions_json",
        str(args.out.resolve()),
    ]
    env = {
        **os.environ,
        "OMP_NUM_THREADS": "1",
        "OPENBLAS_NUM_THREADS": "1",
        "VECLIB_MAXIMUM_THREADS": "1",
        "MKL_NUM_THREADS": "1",
        "MPLCONFIGDIR": str(ROOT / ".cache/matplotlib"),
        "YOLO_CONFIG_DIR": str(ROOT / ".cache/yolo"),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    reused = 0
    if args.resume and args.out.exists():
        reused = prepare_resume(args.out, args.files.resolve())
    started = time.monotonic()
    subprocess.run(command, env=env, check=True)
    count = normalize_paths(args.out, args.files.resolve())
    record = {
        "wall_seconds": time.monotonic() - started,
        "images": count,
        "images_from_checkpoint": reused,
        "speciesnet_version": importlib.metadata.version("speciesnet"),
        "model_version": info["version"],
        "country": "USA",
        "batch_size": 1,
        "max_classifications_per_image": 5,
        "max_classifications_per_detection": 5,
        "weights": weights,
        "weights_downloaded_bytes": 0,
        "filepath_normalization": "Relative to input folder; all prediction fields retained",
        "command": [
            "python",
            "-m",
            "speciesnet.scripts.run_model",
            "--model",
            "<cached-v4.0.3a>",
            "--folders",
            "tools/eval/data/eval_2000",
            *command[7:-2],
            "--predictions_json",
            "tools/eval/results/official_usa.json",
        ],
    }
    args.out.with_suffix(".run.json").write_text(json.dumps(record, indent=2) + "\n")
    print(f"Official run completed in {record['wall_seconds']:.1f} s", flush=True)


if __name__ == "__main__":
    main()
