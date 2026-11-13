"""Regenerate the agreement evaluation from committed predictions; no images or weights required."""

import argparse
import csv
import hashlib
import json
import math
import sys
from pathlib import Path
from typing import NotRequired, TypedDict

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eval.agreement import RESAMPLES, SEED, Detection, Interval, bootstrap, image_labels, outcomes
from eval.ena24_sample import Annotation, Category
from eval.prediction_files import read_predictions

ROOT = Path(__file__).resolve().parents[2]
RESULTS = ROOT / "tools/eval/results"
MIN_REFERENCE_AGREEMENT = 0.995
EXPECTED_IMAGES = 2000
BOX_COORDINATES = 4
HOLDOUT_SIZE = 1000
LEFT_ALIGNED_COLUMNS = 2
METRIC_NAMES = {
    "image_agreement": "Image label-list agreement",
    "detection_agreement": "Detection agreement (IoU >= 0.5)",
    "blank_agreement": "Blank / non-blank agreement",
    "missed_vs_ena24": "Missed animals / ENA24 animal images",
    "missed_vs_official": "Missed animals / official animal images",
    "species_accuracy": "ENA24 species accuracy (single species)",
    "family_accuracy": "ENA24 family accuracy (single species)",
    "rolled_up": "Animal labels rolled above species",
    "rolled_above_family": "Animal labels rolled above family",
}


class ImageRecord(TypedDict):
    file_name: str
    sha256: str
    bytes: int
    annotations: list[Annotation]
    location: NotRequired[str]
    location_id: NotRequired[str]
    camera_id: NotRequired[str]


class Dataset(TypedDict):
    n: int
    seed: int
    image_bytes: int
    exclusion_sha256: str
    excluded_count: int
    metadata_url: str
    metadata_sha256: str
    resampling_unit: str
    categories: list[Category]
    images: list[ImageRecord]


class ModeReport(TypedDict):
    metrics: dict[str, Interval]
    disagreements: list[str]


def load_predictions(
    path: Path, expected: set[str], backend: str | None = None
) -> dict[str, list[Detection]]:
    if backend is not None:
        record = json.loads(path.with_suffix(".run.json").read_text())
        runs = record["backends"]
        if (
            len(runs) != 1
            or runs[0]["actualBackend"] != backend
            or runs[0]["photos"] != len(expected)
            or runs[0]["failedPhotos"] != 0
        ):
            raise ValueError(f"Expected a complete {backend} run for {path}")
    result: dict[str, list[Detection]] = {}
    for prediction in read_predictions(path):
        name = prediction["filepath"].split("/eval_2000/")[-1]
        if prediction.get("failures"):
            raise ValueError(f"Inference failure in {path}: {prediction}")
        if name not in expected or name in result:
            raise ValueError(f"Unexpected or duplicate prediction in {path}: {name}")
        if prediction.get("country", "USA") != "USA":
            raise ValueError(f"Expected USA predictions in {path}: {name}")
        detections = prediction["detections"]
        for detection in detections:
            if (
                len(detection["bbox"]) != BOX_COORDINATES
                or not all(math.isfinite(value) for value in detection["bbox"])
                or any(value < 0 for value in detection["bbox"][2:])
            ):
                raise ValueError(f"Invalid box in {path}: {name}")
        result[name] = detections
    if result.keys() != expected:
        raise ValueError(f"Incomplete prediction set in {path}; expected {len(expected)} images")
    return result


def evaluate(
    dataset: Dataset,
    mapping: dict[int, str],
    wild: dict[str, list[Detection]],
    official: dict[str, list[Detection]],
) -> ModeReport:
    all_rows: dict[str, list[tuple[int, int]]] = {key: [] for key in METRIC_NAMES}
    groups: list[str] = []
    disagreements: list[str] = []
    for image in dataset["images"]:
        name = image["file_name"]
        truth = sorted({mapping[a["category_id"]] for a in image["annotations"]})
        groups.append(
            str(image.get("location", image.get("location_id", image.get("camera_id", name))))
        )
        for key, value in outcomes(wild[name], official[name], truth).items():
            all_rows[key].append(value)
        if image_labels(wild[name]) != image_labels(official[name]):
            disagreements.append(name)
    return {
        "metrics": {key: bootstrap(rows, groups) for key, rows in all_rows.items()},
        "disagreements": disagreements,
    }


def percentage(value: float | None) -> str:
    return "n/a" if value is None else f"{100 * value:.2f}%"


def render_summary(modes: dict[str, ModeReport], images: int, country: str) -> str:
    metrics = modes["Default"]["metrics"]
    species = metrics["species_accuracy"]
    official = modes["Official"]["metrics"]["species_accuracy"]
    summary = (
        f"On {images:,} ENA24 photos ({country}), the WebGPU experiment using the default pipeline "
        "(fp32 detector, fp16 classifier) names the right species in "
        f"**{percentage(species['value'])}** of single-species photos "
        f"(95% CI {percentage(species['lower'])} to {percentage(species['upper'])}); "
        f"official SpeciesNet scores **{percentage(official['value'])}** on the same photos. "
        "It agrees with the official empty-or-not call on "
        f"**{percentage(metrics['blank_agreement']['value'])}**. Exact label lists, "
        "one entry per detection, match on "
        f"**{percentage(metrics['image_agreement']['value'])}**. "
        "ENA24 may overlap SpeciesNet training data, so this is not an independent benchmark."
    )
    return summary + " The WASM app build is not separately measured."


def render_table(modes: dict[str, ModeReport]) -> str:
    rows = [["Pipeline", "Metric", "Measured", "Bootstrap 95% CI", "Count"]]
    for mode, report in modes.items():
        for metric, interval in report["metrics"].items():
            if mode == "Official" and metric in {
                "image_agreement",
                "detection_agreement",
                "blank_agreement",
                "missed_vs_official",
            }:
                continue
            rows.append(
                [
                    "Default (WebGPU)" if mode == "Default" else mode,
                    METRIC_NAMES[metric],
                    percentage(interval["value"]),
                    f"{percentage(interval['lower'])} to {percentage(interval['upper'])}",
                    f"{interval['numerator']}/{interval['denominator']}",
                ]
            )
    widths = [max(len(row[column]) for row in rows) for column in range(len(rows[0]))]
    lines = [
        "| "
        + " | ".join(
            cell.ljust(width) if column < LEFT_ALIGNED_COLUMNS else cell.rjust(width)
            for column, (cell, width) in enumerate(zip(row, widths, strict=True))
        )
        + " |"
        for row in rows
    ]
    separator = (
        "| "
        + " | ".join(
            "-" * width if column < LEFT_ALIGNED_COLUMNS else "-" * (width - 1) + ":"
            for column, width in enumerate(widths)
        )
        + " |"
    )
    lines.insert(1, separator)
    return "\n".join(lines)


def load_inputs() -> tuple[Dataset, dict[int, str], set[str]]:
    dataset: Dataset = json.loads((RESULTS / "dataset.json").read_text())
    if dataset["seed"] != SEED:
        raise ValueError("The evaluation needs seed 20261104")
    if dataset["n"] != EXPECTED_IMAGES or len(dataset["images"]) != EXPECTED_IMAGES:
        raise ValueError("The evaluation needs exactly 2,000 images")
    names = {image["file_name"] for image in dataset["images"]}
    if len(names) != EXPECTED_IMAGES:
        raise ValueError("Dataset contains duplicate paths")
    exclusion = ROOT / "tools/eval/lists/selection_1000.txt"
    excluded = {line.split()[-1] for line in exclusion.read_text().splitlines() if line.strip()}
    if (
        len(excluded) != HOLDOUT_SIZE
        or len(excluded) != dataset["excluded_count"]
        or names & excluded
    ):
        raise ValueError("Evaluation must be disjoint from a nonempty detector holdout")
    if hashlib.sha256(exclusion.read_bytes()).hexdigest() != dataset["exclusion_sha256"]:
        raise ValueError("Exclusion list checksum changed")
    with (ROOT / "tools/eval/ena24_to_speciesnet.csv").open() as stream:
        mapping = {int(row["ena24_id"]): row["speciesnet_label"] for row in csv.DictReader(stream)}
    selected_list = (ROOT / "tools/eval/lists/eval_2000.txt").read_text()
    expected_list = "".join(
        f"{image['sha256']}  {image['file_name']}\n" for image in dataset["images"]
    )
    if selected_list != expected_list:
        raise ValueError("Evaluation list and dataset checksums disagree")
    taxonomy = set((RESULTS / "taxonomy.txt").read_text().splitlines())
    if set(mapping) != {category["id"] for category in dataset["categories"]}:
        raise ValueError("Mapping must cover every ENA24 category")
    if not set(mapping.values()) <= taxonomy:
        raise ValueError("Mapping contains a label absent from SpeciesNet taxonomy")
    return dataset, mapping, names


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    dataset, mapping, names = load_inputs()
    official = load_predictions(RESULTS / "official_usa.json", names)
    modes = {
        "Default": evaluate(
            dataset,
            mapping,
            load_predictions(RESULTS / "wild_default.json", names, "webgpu"),
            official,
        )
    }
    modes["Official"] = evaluate(dataset, mapping, official, official)
    reference_path = RESULTS / "wild_reference.json"
    if reference_path.exists():
        modes["Reference"] = evaluate(
            dataset, mapping, load_predictions(reference_path, names), official
        )
    reference_agreement = (
        modes["Reference"]["metrics"]["image_agreement"]["value"]
        if reference_path.exists()
        else None
    )
    multi_species = sum(
        len({a["category_id"] for a in image["annotations"] if a["category_id"] not in {8, 9}}) > 1
        for image in dataset["images"]
    )
    result = {
        "images": dataset["n"],
        "country": "USA",
        "seed": SEED,
        "resamples": RESAMPLES,
        "resampling_unit": dataset["resampling_unit"],
        "multi_species_excluded": multi_species,
        "image_bytes": dataset["image_bytes"],
        "modes": {
            "Default (WebGPU)" if mode == "Default" else mode: values
            for mode, values in modes.items()
        },
    }
    if reference_path.exists():
        result["reference_meets_agreement_threshold"] = (
            reference_agreement is not None and reference_agreement >= MIN_REFERENCE_AGREEMENT
        )
    summary = render_summary(modes, dataset["n"], "USA")
    table = render_table(modes)
    reference_note = (
        "Reference mode is not evaluated here: its 16-image parity check has not passed yet."
        if not reference_path.exists()
        else "Reference mode requires at least 99.5% image agreement. Every disagreement:\n"
        + ("\n".join(f"- {name}" for name in modes["Reference"]["disagreements"]) or "None.")
    )
    markdown = f"""# Fidelity evaluation

{summary}

{reference_note}

{table}

## Dataset and interpretation

Country USA; 2,000 distinct public ENA24 images; seed {SEED}; class-stratified,
not a prevalence-weighted estimate. ENA24 provides no empty-category ground
truth, so blank agreement is against official outputs, not blank specificity.
Images are disjoint from the 1,000-path
substitute detector holdout in [ADR 0013](adr/0013-ena24-evaluation-holdout.md).
The substitute detector was not compared against the original on a separate holdout.
Image transfer: {dataset["image_bytes"]:,} bytes. Dataset provenance, boxes,
dimensions and checksums are committed in `tools/eval/results/dataset.json`.
Original [ENA24 metadata]({dataset["metadata_url"]}) SHA-256:
`{dataset["metadata_sha256"]}`.

Intervals use {RESAMPLES:,} percentile bootstrap resamples, seed {SEED}, by
{dataset["resampling_unit"]}. The original metadata was inspected: no location,
location_id or camera_id fields exist. Correlated frames can make image-bootstrap
intervals optimistic; these intervals are not camera-independent estimates.
SpeciesNet training data may include ENA24. Accuracy here is **not an independent
benchmark** of generalization.

## Fixed definitions

- Image agreement compares sorted lists of processed classes, preserving duplicates.
  No classified detections means blank. Blank agreement compares blank/non-blank,
  so an unclassified-only image is blank under this convention.
- Detection agreement uses maximum-cardinality one-to-one geometric matching at
  IoU >= 0.5; free candidates are preferred, with descending IoU and original
  index as deterministic tie-breaks before augmenting the matching.
  Classes are compared after matching. Denominator: matched pairs plus unmatched
  classified detections on either side. Unclassified boxes are excluded.
- An animal is the animal label or a taxonomy descendant. A missed animal has no
  animal label despite an ENA24 animal box (human and vehicle boxes excluded), or
  despite an animal label in the official run. Rates use those positive images.
- Accuracy uses images with exactly one distinct ENA24 animal species. A species
  match is present in the predicted list; family accuracy requires a label at
  family level or below in that family. Above-family labels fail both accuracies.
  Generic Bird and vehicle-only images have no species target and are excluded;
  {multi_species} images with multiple animal categories are excluded. The
  rollup shares use classified animal labels as their denominator; both all
  above-species rollups and the above-family subset are shown.

## Reproduce

```sh
uv sync --project tools --locked --group reference
uv run --project tools --group reference python tools/eval/ena24_sample.py \\
  --n 2000 --seed 20261104 --exclude tools/eval/lists/selection_1000.txt \\
  --out tools/eval/lists/eval_2000.txt
uv run --project tools --group reference python tools/eval/run_official.py
uv run --project tools python tools/eval/prediction_files.py tools/eval/results/official_usa.json
npm run bench:photos -- --files tools/eval/data/eval_2000 --mode default \\
  --country USA --export tools/eval/results/wild_default.json \\
  --results tools/eval/results/wild_default.run.json
uv run --project tools python tools/eval/prediction_files.py tools/eval/results/wild_default.json
npm run eval:report
```

The official run uses SpeciesNet 5.0.6 / v4.0.3a, cached classifier and MDv5a
weights, batch size one, top five classes per image and per detection. CPU math
libraries are limited to one thread. Browser export runs only its requested
backend; the default export requests WebGPU (with ORT operator fallback), the fp32
RT-DETR detector and fp16 crop-classifier exports selected by the app's shared
model-selection function. The WebGPU experiment uses the app's production model
choices with a different execution backend. The app selects WASM and is not
separately measured. Pass `--wasm` and a separate export path to the browser
benchmark to measure that backend without replacing the WebGPU evidence.
Run records in `tools/eval/results/` retain versions, timings and weight hashes.
Prediction exports are small indices plus checksum-verified gzip shards of 100
images, preserving every raw detection and classification without rounding.
On this Mac set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to the installed Brave binary.
`npm run eval:report` needs only committed small files, not images or weights.
"""
    outputs = {
        ROOT / "docs/evaluation.md": markdown,
        ROOT / "docs/evaluation.json": json.dumps(result, indent=2) + "\n",
    }
    readme_path = ROOT / "README.md"
    readme = readme_path.read_text()
    start, end = "<!-- evaluation:results -->", "<!-- /evaluation:results -->"
    if start not in readme or end not in readme:
        raise ValueError("README needs the evaluation:results markers")
    prefix, rest = readme.split(start, 1)
    _, suffix = rest.split(end, 1)
    headline = modes["Default"]["metrics"]["image_agreement"]
    outputs[readme_path] = (
        prefix
        + start
        + "\n"
        + summary
        + " [Definitions and limits](docs/evaluation.md).\n"
        + end
        + suffix
    )
    for path, content in outputs.items():
        if args.check:
            if not path.exists() or path.read_text() != content:
                raise ValueError(f"Stale {path.relative_to(ROOT)}; run npm run eval:report")
        else:
            path.write_text(content)
    print(
        f"WebGPU default image agreement "
        f"{percentage(headline['value'])}; docs {'verified' if args.check else 'written'}"
    )
    if reference_path.exists() and (
        reference_agreement is None or reference_agreement < MIN_REFERENCE_AGREEMENT
    ):
        raise SystemExit("Reference image agreement is below the required 99.5%")


if __name__ == "__main__":
    main()
