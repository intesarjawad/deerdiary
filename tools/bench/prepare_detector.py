import argparse
import json
import shutil
from pathlib import Path
from tempfile import gettempdir

import numpy as np

from eval.onnx_selection import Model, model_file
from export.rtdetr_source import IMAGE_COUNT, REFERENCE_DIR, Reference
from export.rtdetr_verify import validate_reference
from export.speciesnet_source import ROOT, integrity


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare verified browser detector fixtures")
    parser.add_argument("--include-sorrel", action="store_true")
    parser.add_argument("--model-cache", type=Path, default=Path(gettempdir()) / "deerdiary-models")
    args = parser.parse_args()
    record: Reference = json.loads((REFERENCE_DIR / "reference.json").read_text())
    validate_reference(record)
    manifest = json.loads((ROOT / "models/manifest.json").read_text())
    destination = ROOT / ".cache/detector-bench"
    destination.mkdir(parents=True, exist_ok=True)
    models: list[dict[str, object]] = []
    for model in manifest["local_detector_exports"]["files"]:
        source = ROOT / model["local_path"]
        if integrity(source) != {"bytes": model["bytes"], "sha256": model["sha256"]}:
            raise ValueError(f"Model integrity mismatch: {source}")
        shutil.copyfile(source, destination / source.name)
        models.append(
            {"id": model["id"], "kind": "rtdetr", "url": source.name, **integrity(source)}
        )
    cases: list[dict[str, object]] = []
    for index, name in enumerate(record["cases"][:IMAGE_COUNT]):
        with np.load(REFERENCE_DIR / f"{index:03}.npz", allow_pickle=False) as fixture:
            tensor = destination / f"{index:03}.bin"
            tensor.write_bytes(fixture["images"].astype("<f4").tobytes())
            cases.append(
                {
                    "name": name,
                    "url": tensor.name,
                    **integrity(tensor),
                    "size": fixture["orig_target_sizes"][0].tolist(),
                    "expected": {
                        key: fixture[key].reshape(-1).tolist()
                        for key in ("labels", "boxes", "scores")
                    },
                }
            )
    if args.include_sorrel:
        sorrel: Model = next(model for model in manifest["files"] if model["id"] == "sorrel")
        source = model_file(sorrel, args.model_cache)
        shutil.copyfile(source, destination / "sorrel.onnx")
        models.append({"id": "sorrel", "kind": "sorrel", "url": "sorrel.onnx", **integrity(source)})
        prepared = ROOT / ".cache/detector-sorrel"
        sorrel_cases = json.loads((prepared / "fixtures.json").read_text())["cases"]
        if [case["name"] for case in sorrel_cases] != record["cases"][:IMAGE_COUNT]:
            raise ValueError("Sorrel golden images differ; rerun bench.prepare_sorrel")
        for case, extra in zip(cases, sorrel_cases, strict=True):
            tensor = prepared / extra["url"]
            if integrity(tensor) != {"bytes": extra["bytes"], "sha256": extra["sha256"]}:
                raise ValueError(f"Stale sorrel tensor: {tensor}")
            shutil.copyfile(tensor, destination / tensor.name)
            case["sorrel"] = extra
    (destination / "fixtures.json").write_text(
        json.dumps(
            {
                "models": models,
                "cases": cases,
                "reference": integrity(REFERENCE_DIR / "reference.json"),
            }
        )
        + "\n"
    )
    print(f"Prepared {len(models)} models and {len(cases)} pinned image tensors in {destination}")


if __name__ == "__main__":
    main()
