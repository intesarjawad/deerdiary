"""Agreement and accuracy metrics over paired, classified detections."""

import math
import random
from collections import defaultdict
from typing import NotRequired, TypedDict

SEED = 20261104
RESAMPLES = 1000
IOU_THRESHOLD = 0.5
BLANK = "f1856211-cfb7-4a5b-9158-c0f72fd09ee6;;;;;;blank"


# The upstream JSON field is a Python keyword; retain its spelling at this boundary.
ProcessedLabel = TypedDict("ProcessedLabel", {"class": str})


class Detection(TypedDict):
    bbox: list[float]
    processed_classification: NotRequired[ProcessedLabel]


class Interval(TypedDict):
    numerator: int
    denominator: int
    value: float | None
    lower: float | None
    upper: float | None


def image_labels(detections: list[Detection]) -> list[str]:
    labels = sorted(
        d["processed_classification"]["class"]
        for d in detections
        if "processed_classification" in d
    )
    return labels or [BLANK]


def iou(a: list[float], b: list[float]) -> float:
    width = max(0.0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0]))
    height = max(0.0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
    intersection = width * height
    union = a[2] * a[3] + b[2] * b[3] - intersection
    return intersection / union if union > 0 else 0


def detection_agreement(left: list[Detection], right: list[Detection]) -> tuple[int, int]:
    left = [d for d in left if "processed_classification" in d]
    right = [d for d in right if "processed_classification" in d]
    edges = [
        sorted(
            (j for j, b in enumerate(right) if iou(a["bbox"], b["bbox"]) >= IOU_THRESHOLD),
            key=lambda j: (-iou(a["bbox"], right[j]["bbox"]), j),
        )
        for a in left
    ]
    matched: dict[int, int] = {}

    def augment(index: int, seen: set[int]) -> bool:
        for other in edges[index]:
            if other not in matched:
                matched[other] = index
                return True
        for other in edges[index]:
            if other in seen:
                continue
            seen.add(other)
            if augment(matched[other], seen):
                matched[other] = index
                return True
        return False

    for index in range(len(left)):
        augment(index, set())
    correct = sum(image_labels([left[i]]) == image_labels([right[j]]) for j, i in matched.items())
    return correct, len(left) + len(right) - len(matched)


def bootstrap(
    rows: list[tuple[int, int]], groups: list[str], resamples: int = RESAMPLES, seed: int = SEED
) -> Interval:
    if not rows or len(rows) != len(groups):
        raise ValueError("Need nonempty aligned outcomes and groups")
    clustered: dict[str, tuple[int, int]] = defaultdict(lambda: (0, 0))
    for (numerator, denominator), group in zip(rows, groups, strict=True):
        if not 0 <= numerator <= denominator:
            raise ValueError("Invalid metric counts")
        previous = clustered[group]
        clustered[group] = (previous[0] + numerator, previous[1] + denominator)
    numerator = sum(row[0] for row in rows)
    denominator = sum(row[1] for row in rows)
    result: Interval = {
        "numerator": numerator,
        "denominator": denominator,
        "value": numerator / denominator if denominator else None,
        "lower": None,
        "upper": None,
    }
    if not denominator:
        return result
    randomizer = random.Random(seed)
    clusters = [clustered[key] for key in sorted(clustered)]
    estimates: list[float] = []
    for _ in range(resamples):
        chosen = randomizer.choices(clusters, k=len(clusters))
        count = sum(row[1] for row in chosen)
        if count:
            estimates.append(sum(row[0] for row in chosen) / count)
    estimates.sort()
    if estimates:
        result["lower"] = estimates[math.floor(0.025 * len(estimates))]
        result["upper"] = estimates[math.ceil(0.975 * len(estimates)) - 1]
    return result


def is_animal(label: str) -> bool:
    parts = label.split(";")
    return parts[-1] == "animal" or (bool(parts[1]) and parts[1] != "no cv result")


def is_blank(labels: list[str]) -> bool:
    return all(label.split(";")[-1] == "blank" for label in labels)


def outcomes(
    wild: list[Detection], official: list[Detection], truth: list[str]
) -> dict[str, tuple[int, int]]:
    labels = image_labels(wild)
    reference = image_labels(official)
    found = any(is_animal(label) for label in labels)
    reference_found = any(is_animal(label) for label in reference)
    animal_truth = [
        label for label in truth if is_animal(label) and label.split(";")[-1] != "human"
    ]
    eligible = len(set(animal_truth)) == 1 and bool(animal_truth[0].split(";")[5])
    target = animal_truth[0] if eligible else BLANK
    family = target.split(";")[1:4]
    classified_animals = [label for label in labels if is_animal(label)]
    return {
        "image_agreement": (int(labels == reference), 1),
        "detection_agreement": detection_agreement(wild, official),
        "blank_agreement": (int(is_blank(labels) == is_blank(reference)), 1),
        "missed_vs_ena24": (int(bool(animal_truth) and not found), int(bool(animal_truth))),
        "missed_vs_official": (int(reference_found and not found), int(reference_found)),
        "species_accuracy": (int(eligible and target in labels), int(eligible)),
        "family_accuracy": (
            int(
                eligible
                and any(
                    label.split(";")[1:4] == family and bool(label.split(";")[3])
                    for label in labels
                )
            ),
            int(eligible),
        ),
        "rolled_up": (
            sum(not label.split(";")[5] for label in classified_animals),
            len(classified_animals),
        ),
        "rolled_above_family": (
            sum(not label.split(";")[3] for label in classified_animals),
            len(classified_animals),
        ),
    }
