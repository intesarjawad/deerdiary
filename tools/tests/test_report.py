import csv
import json
from pathlib import Path

import pytest

from eval.agreement import (
    Detection,
    Interval,
    bootstrap,
    detection_agreement,
    image_labels,
    outcomes,
)
from eval.ena24_sample import read_list, validate_existing
from eval.prediction_files import pack, read_predictions
from eval.report import ModeReport, load_predictions, render_summary
from eval.run_official import normalize_paths, prepare_resume

DEER = "id;mammalia;artiodactyla;cervidae;odocoileus;virginianus;deer"
FAMILY = "family;mammalia;artiodactyla;cervidae;;;cervidae family"
ANIMAL = "animal;;;;;;animal"
BLANK = "f1856211-cfb7-4a5b-9158-c0f72fd09ee6;;;;;;blank"


def detection(label: str, box: list[float] | None = None) -> Detection:
    return {"bbox": box or [0, 0, 1, 1], "processed_classification": {"class": label}}


def test_image_labels_sort_preserve_duplicates_and_use_blank() -> None:
    assert image_labels([]) == [BLANK]
    assert image_labels([detection(BLANK)]) == image_labels([])
    assert image_labels([{"bbox": [0, 0, 1, 1]}]) == [BLANK]
    assert image_labels([detection(DEER), detection(ANIMAL), detection(DEER)]) == sorted(
        [DEER, ANIMAL, DEER]
    )


def test_iou_boundary_unmatched_boxes_and_classes() -> None:
    assert detection_agreement([detection(DEER)], [detection(DEER, [0, 0, 0.5, 1])]) == (1, 1)
    assert detection_agreement([detection(DEER)], [detection(DEER, [0, 0, 0.49, 1])]) == (0, 2)
    assert detection_agreement([detection(DEER)], [detection(FAMILY)]) == (0, 1)
    assert detection_agreement([], []) == (0, 0)
    assert detection_agreement([detection(DEER), detection(DEER)], [detection(DEER)]) == (1, 2)


def test_matching_maximizes_geometric_cardinality_before_comparing_labels() -> None:
    left = [detection(DEER, [0.125, 0, 0.75, 1]), detection(DEER, [0, 0, 0.75, 1])]
    right = [detection(DEER, [0, 0, 0.75, 1]), detection(DEER, [0.375, 0, 0.75, 1])]
    assert detection_agreement(left, right) == (2, 2)


def test_grouped_bootstrap_resamples_whole_locations_and_is_seeded() -> None:
    rows = [(1, 1)] * 99 + [(0, 1)]
    groups = ["A"] * 99 + ["B"]
    interval = bootstrap(rows, groups)
    assert interval == bootstrap(rows, groups)
    assert interval["value"] == 0.99
    assert interval["lower"] == 0
    assert interval["upper"] == 1
    image_lower = bootstrap(rows, [str(i) for i in range(100)])["lower"]
    assert image_lower is not None
    assert image_lower > 0.9
    assert bootstrap([(0, 0)], ["A"])["value"] is None
    with pytest.raises(ValueError, match="aligned"):
        bootstrap(rows, ["A"])


def test_species_family_rollup_misses_and_multispecies_exclusion() -> None:
    family = outcomes([detection(FAMILY)], [detection(DEER)], [DEER])
    assert family["species_accuracy"] == (0, 1)
    assert family["family_accuracy"] == (1, 1)
    assert family["rolled_above_family"] == (0, 1)
    assert family["rolled_up"] == (1, 1)
    animal = outcomes([detection(ANIMAL)], [detection(DEER)], [DEER])
    assert animal["missed_vs_ena24"] == (0, 1)
    assert animal["family_accuracy"] == (0, 1)
    assert animal["rolled_above_family"] == (1, 1)
    blank = outcomes([], [detection(DEER)], [DEER])
    assert blank["missed_vs_ena24"] == (1, 1)
    assert blank["missed_vs_official"] == (1, 1)
    assert blank["blank_agreement"] == (0, 1)
    assert outcomes([], [], [DEER, FAMILY])["species_accuracy"] == (0, 0)


def test_every_ena24_target_exists_in_committed_taxonomy() -> None:
    root = Path(__file__).resolve().parents[1] / "eval"
    taxonomy = set((root / "results/taxonomy.txt").read_text().splitlines())
    with (root / "ena24_to_speciesnet.csv").open() as stream:
        mapping = list(csv.DictReader(stream))
    assert len(mapping) == 23
    assert len({row["ena24_id"] for row in mapping}) == 23
    assert all(row["speciesnet_label"] in taxonomy for row in mapping)


def test_prediction_reader_rejects_missing_duplicates_and_failures(tmp_path: Path) -> None:
    path = tmp_path / "predictions.json"
    path.write_text(json.dumps({"predictions": []}))
    with pytest.raises(ValueError, match="Incomplete"):
        load_predictions(path, {"a.jpg"})
    prediction: dict[str, object] = {"filepath": "a.jpg", "detections": []}
    path.write_text(json.dumps({"predictions": [prediction, prediction]}))
    with pytest.raises(ValueError, match="duplicate"):
        load_predictions(path, {"a.jpg"})
    prediction["failures"] = ["decode failed"]
    path.write_text(json.dumps({"predictions": [prediction]}))
    with pytest.raises(ValueError, match="Inference failure"):
        load_predictions(path, {"a.jpg"})


def test_no_cv_result_is_not_an_animal_or_an_above_family_animal_label() -> None:
    unknown = "id;no cv result;no cv result;no cv result;no cv result;no cv result;no cv result"
    result = outcomes([detection(unknown)], [detection(DEER)], [DEER])
    assert result["missed_vs_ena24"] == (1, 1)
    assert result["missed_vs_official"] == (1, 1)
    assert result["rolled_above_family"] == (0, 0)


def test_holdout_cannot_be_empty_or_duplicate(tmp_path: Path) -> None:
    path = tmp_path / "selection.txt"
    for contents in ("", "a.jpg\na.jpg\n"):
        path.write_text(contents)
        with pytest.raises(ValueError, match="nonempty and unique"):
            read_list(path)
    path.write_text("a.jpg\nb.jpg\n")
    assert read_list(path) == {"a.jpg", "b.jpg"}


def test_sampler_rejects_extra_images_and_changed_selections(tmp_path: Path) -> None:
    images = tmp_path / "images"
    images.mkdir()
    (images / "extra.jpg").touch()
    output = tmp_path / "list.txt"
    with pytest.raises(ValueError, match="unselected images"):
        validate_existing(images, output, {"a.jpg"})
    output.write_text("digest  b.jpg\n")
    with pytest.raises(ValueError, match="different images"):
        validate_existing(images, output, {"extra.jpg"})
    output.write_text("digest  extra.jpg\n")
    assert validate_existing(images, output, {"extra.jpg"}) == {"extra.jpg": "digest"}


def test_official_paths_normalize_without_dropping_predictions(tmp_path: Path) -> None:
    image = tmp_path / "a.jpg"
    image.touch()
    path = tmp_path / "predictions.json"
    path.write_text(
        json.dumps(
            {
                "info": {"version": "test"},
                "predictions": [{"filepath": str(image), "detections": [], "country": "USA"}],
            }
        )
    )
    assert normalize_paths(path, tmp_path) == 1
    batch = json.loads(path.read_text())
    assert batch["info"] == {"version": "test"}
    assert batch["predictions"] == [{"filepath": "a.jpg", "detections": [], "country": "USA"}]
    assert prepare_resume(path, tmp_path) == 1
    assert json.loads(path.read_text())["predictions"][0]["filepath"] == str(image)
    assert normalize_paths(path, tmp_path) == 1
    path.write_text(json.dumps({"predictions": [{"filepath": "a.jpg", "failures": ["pending"]}]}))
    with pytest.raises(ValueError, match="inference failed"):
        normalize_paths(path, tmp_path)


def test_identical_overlapping_detections_agree_with_themselves() -> None:
    detections = [detection(DEER), detection(FAMILY)]
    assert detection_agreement(detections, detections) == (2, 2)


def test_prediction_shards_are_lossless_deterministic_and_loadable(tmp_path: Path) -> None:
    predictions = [
        {"filepath": f"{i}.jpg", "detections": [detection(DEER)], "country": "USA"}
        for i in range(101)
    ]
    batch = {"info": {"version": "test"}, "predictions": predictions, "extra": "preserved"}
    raw = json.dumps(batch)
    path = tmp_path / "wild.json"
    path.write_text(raw)
    pack(path)
    index = json.loads(path.read_text())
    assert len(index["shards"]) == 2
    assert index["metadata"] == {"info": {"version": "test"}, "extra": "preserved"}
    assert read_predictions(path) == predictions
    assert len(load_predictions(path, {f"{i}.jpg" for i in range(101)})) == 101
    hashes = [shard["sha256"] for shard in index["shards"]]
    path.write_text(raw)
    pack(path)
    assert [shard["sha256"] for shard in json.loads(path.read_text())["shards"]] == hashes


def test_prediction_shards_reject_corruption_and_path_escape(tmp_path: Path) -> None:
    path = tmp_path / "wild.json"
    path.write_text(json.dumps({"predictions": [{"filepath": "a.jpg", "detections": []}]}))
    pack(path)
    index = json.loads(path.read_text())
    shard = tmp_path / index["shards"][0]["file"]
    shard.write_bytes(b"corrupt")
    with pytest.raises(ValueError, match="checksum"):
        read_predictions(path)
    index["shards"][0]["file"] = "../outside.json.gz"
    path.write_text(json.dumps(index))
    with pytest.raises(ValueError, match="escapes"):
        read_predictions(path)


def test_official_resume_rejects_published_shard_indices(tmp_path: Path) -> None:
    path = tmp_path / "index.json"
    path.write_text(json.dumps({"shards": []}))
    with pytest.raises(ValueError, match="unpacked CLI checkpoint"):
        prepare_resume(path, tmp_path)


def test_summary_leads_with_species_accuracy_and_uses_result_values() -> None:
    def metric(value: float) -> Interval:
        return {
            "value": value,
            "lower": value - 0.01,
            "upper": value + 0.01,
            "numerator": 1,
            "denominator": 2,
        }

    modes: dict[str, ModeReport] = {
        "Default": {
            "metrics": {
                "species_accuracy": metric(0.8),
                "blank_agreement": metric(0.99),
                "image_agreement": metric(0.4),
            },
            "disagreements": [],
        },
        "Official": {"metrics": {"species_accuracy": metric(0.81)}, "disagreements": []},
    }
    assert render_summary(modes, 1234, "USA") == (
        "On 1,234 ENA24 photos (USA), the WebGPU experiment using the default pipeline "
        "(fp32 detector, fp16 classifier) names the right species in **80.00%** "
        "of single-species photos (95% CI 79.00% to 81.00%); official SpeciesNet "
        "scores **81.00%** on the same photos. It agrees with the official empty-or-not "
        "call on **99.00%**. Exact label lists, one entry per detection, match on **40.00%**. "
        "ENA24 may overlap SpeciesNet training data, so this is not an independent benchmark. "
        "The WASM app build is not separately measured."
    )


def test_browser_results_require_the_named_backend_and_complete_run(tmp_path: Path) -> None:
    path = tmp_path / "wild_wasm.json"
    path.write_text(json.dumps({"predictions": [{"filepath": "a.jpg", "detections": []}]}))
    record = path.with_suffix(".run.json")
    for backend, count, failed in [("webgpu", 1, 0), ("wasm", 0, 0), ("wasm", 1, 1)]:
        record.write_text(
            json.dumps(
                {"backends": [{"actualBackend": backend, "photos": count, "failedPhotos": failed}]}
            )
        )
        with pytest.raises(ValueError, match="complete wasm run"):
            load_predictions(path, {"a.jpg"}, "wasm")
    record.write_text(
        json.dumps({"backends": [{"actualBackend": "wasm", "photos": 1, "failedPhotos": 0}]})
    )
    assert load_predictions(path, {"a.jpg"}, "wasm") == {"a.jpg": []}
