import numpy as np
from numpy.typing import NDArray

MDV5A_CONFIDENCE_FLOOR = 0.01
NMS_IOU = 0.45
MAX_DETECTIONS = 300
MAX_NMS_CANDIDATES = 30000
RTDETR_OUTPUT_COUNT = 3


def mdv5a_animal_score(rows: NDArray[np.float32]) -> float:
    classes = np.argmax(rows[:, 5:], axis=1)
    confidence = rows[:, 4] * np.max(rows[:, 5:], axis=1)
    candidates = np.flatnonzero(confidence > MDV5A_CONFIDENCE_FLOOR)
    order = candidates[np.argsort(-confidence[candidates], kind="stable")[:MAX_NMS_CANDIDATES]]
    corners = np.concatenate(
        (rows[:, :2] - rows[:, 2:4] / 2, rows[:, :2] + rows[:, 2:4] / 2), axis=1
    )
    count = 0
    while len(order) and count < MAX_DETECTIONS:
        index = int(order[0])
        count += 1
        if classes[index] == 0:
            return float(confidence[index])
        remaining = order[1:]
        sides = np.maximum(
            0,
            np.minimum(corners[index, 2:], corners[remaining, 2:])
            - np.maximum(corners[index, :2], corners[remaining, :2]),
        )
        intersection = np.prod(sides, axis=1)
        area = np.prod(rows[index, 2:4])
        areas = np.prod(rows[remaining, 2:4], axis=1)
        union = area + areas - intersection
        overlap = np.divide(intersection, union, out=np.zeros_like(intersection), where=union > 0)
        order = remaining[(classes[remaining] != classes[index]) | (overlap <= NMS_IOU)]
    return 0.0


def animal_score(model: str, outputs: list[NDArray[np.generic]]) -> float:
    if model == "rtdetr":
        if len(outputs) != RTDETR_OUTPUT_COUNT:
            raise ValueError("Expected three RT-DETR outputs")
        labels = np.asarray(outputs[0], dtype=np.int64)
        scores = np.asarray(outputs[2], dtype=np.float32)
        if labels.shape != (1, 300) or scores.shape != (1, 300):
            raise ValueError("Unexpected RT-DETR output shape")
        values = scores[labels == 0]
    elif model in {"sorrel", "mdv5a"}:
        if len(outputs) != 1:
            raise ValueError(f"Expected one {model} output")
        rows = np.asarray(outputs[0], dtype=np.float32)
        shape = (1, 300, 6) if model == "sorrel" else (1, 102000, 8)
        if rows.shape != shape or not np.isfinite(rows).all():
            raise ValueError(f"Unexpected {model} output shape or values")
        if model == "mdv5a":
            values = np.array([mdv5a_animal_score(rows[0])], dtype=np.float32)
        else:
            values = rows[0, :, 4][rows[0, :, 5] == 0]
    else:
        raise ValueError(f"Unknown detector: {model}")
    if not np.isfinite(values).all() or np.any((values < 0) | (values > 1)):
        raise ValueError(f"Invalid scores from {model}")
    return float(np.max(values, initial=0))
