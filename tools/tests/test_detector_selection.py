import numpy as np
import pytest

from eval.detector_scores import animal_score
from eval.prepare_selection import Coco, candidates, sample


def test_sampling_is_seeded_capped_and_independent_of_metadata_order() -> None:
    rows: list[dict[str, object]] = [
        {"path": str(index), "stratum": str(index % 3)} for index in range(12)
    ]
    selected = sample(rows, 6, 2, 20261104)
    assert selected == sample(list(reversed(rows)), 6, 2, 20261104)
    assert len({row["path"] for row in selected}) == 6
    for stratum in range(3):
        assert sum(row["stratum"] == str(stratum) for row in selected) == 2
    with pytest.raises(ValueError, match="Only 6 eligible"):
        sample(rows, 7, 2, 20261104)


def test_coco_requires_explicit_blank_annotation_and_largest_animal_is_small() -> None:
    metadata: Coco = {
        "images": [{"id": i, "file_name": str(i), "width": 100, "height": 100} for i in range(4)],
        "annotations": [
            {"image_id": 0, "category_id": 1, "bbox": [0, 0, 5, 5]},
            {"image_id": 1, "category_id": 1, "bbox": [0, 0, 5, 5]},
            {"image_id": 1, "category_id": 1, "bbox": [0, 0, 20, 20]},
            {"image_id": 2, "category_id": 0, "bbox": []},
        ],
    }
    rows = candidates(metadata, {1}, 0)
    assert [row["path"] for row in rows] == ["0", "1", "2"]
    assert [row["small"] for row in rows] == [True, False, False]
    assert [row["blank"] for row in rows] == [False, False, True]


def test_mdv5a_combines_objectness_and_class_and_excludes_winning_person() -> None:
    output = np.zeros((1, 102000, 8), dtype=np.float32)
    output[0, :2, :4] = [1, 1, 1, 1]
    output[0, 0, 4:] = [0.5, 0.8, 0.1, 0.1]
    output[0, 1, 4:] = [1.0, 0.9, 0.99, 0.1]
    assert animal_score("mdv5a", [output]) == pytest.approx(0.4)


def test_postprocessed_detectors_only_count_animal_scores() -> None:
    rows = np.zeros((1, 300, 6), dtype=np.float32)
    rows[0, 0, 4:] = [0.7, 0]
    rows[0, 1, 4:] = [0.99, 1]
    assert animal_score("sorrel", [rows]) == pytest.approx(0.7)
    labels = np.ones((1, 300), dtype=np.int64)
    labels[0, 0] = 0
    scores = np.ones((1, 300), dtype=np.float32)
    scores[0, 0] = 0.6
    assert animal_score("rtdetr", [labels, np.zeros((1, 300, 4)), scores]) == pytest.approx(0.6)


def test_mdv5a_respects_class_aware_nms_and_the_300_detection_limit() -> None:
    output = np.zeros((1, 102000, 8), dtype=np.float32)
    for index in range(301):
        output[0, index, :4] = [index * 20, 0, 10, 10]
        output[0, index, 4:] = [1, 0.1, 0.9, 0.1]
    output[0, 300, 4:] = [1, 0.8, 0.1, 0.1]
    assert animal_score("mdv5a", [output]) == 0
    output[0, :300, :4] = [0, 0, 10, 10]
    assert animal_score("mdv5a", [output]) == pytest.approx(0.8)
