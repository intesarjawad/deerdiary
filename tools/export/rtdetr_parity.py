import numpy as np
from numpy.typing import NDArray

from export.rtdetr_source import CLASS_COUNT, CONF_TOLERANCE, MIN_IOU, QUERY_COUNT


def validate_outputs(
    labels: NDArray[np.int64], boxes: NDArray[np.float32], scores: NDArray[np.float32]
) -> None:
    if (
        labels.shape != (1, QUERY_COUNT)
        or boxes.shape != (1, QUERY_COUNT, 4)
        or scores.shape != labels.shape
        or labels.dtype != np.int64
        or boxes.dtype != np.float32
        or scores.dtype != np.float32
        or not np.isfinite(boxes).all()
        or not np.isfinite(scores).all()
        or np.any((labels < 0) | (labels >= CLASS_COUNT))
        or np.any((scores < 0) | (scores > 1))
        or np.any(boxes[..., 2:] <= boxes[..., :2])
    ):
        raise ValueError("Invalid detector outputs")


def box_iou(box: NDArray[np.float32], boxes: NDArray[np.float32]) -> NDArray[np.float32]:
    intersection_sides = np.maximum(
        0, np.minimum(box[2:], boxes[:, 2:]) - np.maximum(box[:2], boxes[:, :2])
    )
    intersection = np.prod(intersection_sides, axis=1)
    area = np.prod(box[2:] - box[:2])
    areas = np.prod(boxes[:, 2:] - boxes[:, :2], axis=1)
    return intersection / (area + areas - intersection)


def compare(
    expected: tuple[NDArray[np.int64], NDArray[np.float32], NDArray[np.float32]],
    actual: tuple[NDArray[np.int64], NDArray[np.float32], NDArray[np.float32]],
) -> tuple[float, float]:
    validate_outputs(*expected)
    validate_outputs(*actual)
    labels, boxes, scores = expected
    other_labels, other_boxes, other_scores = actual
    unused = np.ones(QUERY_COUNT, dtype=np.bool_)
    minimum_iou = 1.0
    maximum_conf_error = 0.0
    # TopK ordering can differ on ties; require a class-preserving one-to-one match.
    for index in range(QUERY_COUNT):
        overlaps = box_iou(boxes[0, index], other_boxes[0])
        errors = np.abs(other_scores[0] - scores[0, index])
        candidates = unused & (other_labels[0] == labels[0, index]) & (errors <= CONF_TOLERANCE)
        match = int(np.argmax(np.where(candidates, overlaps, -1)))
        if not candidates[match] or overlaps[match] < MIN_IOU:
            raise ValueError(f"Detector parity failed at query {index}: no matching box/score")
        unused[match] = False
        minimum_iou = min(minimum_iou, float(overlaps[match]))
        maximum_conf_error = max(maximum_conf_error, float(errors[match]))
    return minimum_iou, maximum_conf_error
