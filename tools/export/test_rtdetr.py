import numpy as np
import pytest
from numpy.typing import NDArray

from export.rtdetr_parity import compare
from export.rtdetr_source import QUERY_COUNT

EXPECTED_MINIMUM_IOU = 0.99
EXPECTED_CONFIDENCE_TOLERANCE = 0.001


def outputs() -> tuple[NDArray[np.int64], NDArray[np.float32], NDArray[np.float32]]:
    labels = np.zeros((1, QUERY_COUNT), dtype=np.int64)
    boxes = np.zeros((1, QUERY_COUNT, 4), dtype=np.float32)
    boxes[0, :, 0] = np.arange(QUERY_COUNT) * 20
    boxes[0, :, 2] = boxes[0, :, 0] + 10
    boxes[0, :, 3] = 10
    scores = np.full((1, QUERY_COUNT), 0.5, dtype=np.float32)
    return labels, boxes, scores


def test_accepts_reordered_tied_predictions() -> None:
    labels, boxes, scores = outputs()
    assert compare(outputs(), (labels[:, ::-1], boxes[:, ::-1], scores[:, ::-1])) == (1, 0)


def test_requires_one_to_one_box_matching() -> None:
    labels, boxes, scores = outputs()
    boxes[0, 1] = boxes[0, 0]
    with pytest.raises(ValueError, match="no matching box/score"):
        compare(outputs(), (labels, boxes, scores))


@pytest.mark.parametrize("mutation", ["class", "geometry", "confidence", "nonfinite"])
def test_rejects_parity_violations(mutation: str) -> None:
    labels, boxes, scores = outputs()
    if mutation == "class":
        labels[0, 0] = 1
    elif mutation == "geometry":
        boxes[0, 0, 0] += 1
    elif mutation == "confidence":
        scores[0, 0] += 0.002
    else:
        boxes[0, 0, 0] = np.nan
    with pytest.raises(ValueError, match=r"Invalid detector outputs|no matching box/score"):
        compare(outputs(), (labels, boxes, scores))


def test_accepts_differences_inside_both_tolerances() -> None:
    labels, boxes, scores = outputs()
    boxes[0, 0, 0] += 0.01
    scores[0, 0] += 0.0005
    iou, error = compare(outputs(), (labels, boxes, scores))
    assert iou >= EXPECTED_MINIMUM_IOU
    assert 0 < error <= EXPECTED_CONFIDENCE_TOLERANCE


def test_rejects_missing_queries() -> None:
    labels, boxes, scores = outputs()
    with pytest.raises(ValueError, match="Invalid detector outputs"):
        compare(outputs(), (labels[:, :-1], boxes[:, :-1], scores[:, :-1]))
