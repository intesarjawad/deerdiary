import math
from collections.abc import Sequence
from random import Random
from statistics import mean
from typing import TypedDict

SEED = 20261104
RESAMPLES = 1000
REFERENCE_THRESHOLD = 0.2


class Interval(TypedDict):
    difference: float
    lower: float
    upper: float


def validate_scores(scores: Sequence[float]) -> None:
    if not scores or any(not math.isfinite(x) or not 0 <= x <= 1 for x in scores):
        raise ValueError("Scores must be a nonempty sequence of finite probabilities")


def matched_threshold(blank_scores: Sequence[float], target_rate: float) -> float:
    validate_scores(blank_scores)
    if not math.isfinite(target_rate) or not 0 <= target_rate <= 1:
        raise ValueError("Target false-detection rate must be in [0, 1]")
    candidates = sorted(
        {math.nextafter(max(blank_scores), math.inf), *(x for x in blank_scores if x > 0)}
    )
    # Ties can make the target unattainable; prefer the lower false-detection rate.
    return min(
        candidates,
        key=lambda threshold: (
            abs(mean(x >= threshold for x in blank_scores) - target_rate),
            mean(x >= threshold for x in blank_scores),
            threshold,
        ),
    )


def paired_bootstrap(
    left: Sequence[bool], right: Sequence[bool], *, seed: int = SEED, resamples: int = RESAMPLES
) -> Interval:
    if not left or len(left) != len(right) or resamples < 1:
        raise ValueError("Need equal nonempty paired outcomes and positive resamples")
    differences = [float(a) - float(b) for a, b in zip(left, right, strict=True)]
    random = Random(seed)
    samples = sorted(
        mean(random.choices(differences, k=len(differences))) for _ in range(resamples)
    )
    return {
        "difference": mean(differences),
        "lower": samples[max(0, math.ceil(0.025 * resamples) - 1)],
        "upper": samples[math.ceil(0.975 * resamples) - 1],
    }


def compare_models(
    scores: dict[str, list[float]],
    animal: Sequence[bool],
    small: Sequence[bool],
    blank: Sequence[bool],
) -> dict[str, object]:
    if "mdv5a" not in scores or not animal or not (len(animal) == len(small) == len(blank)):
        raise ValueError("Need MDv5a and aligned nonempty ground truth")
    if any((a and b) or (s and not a) for a, s, b in zip(animal, small, blank, strict=True)):
        raise ValueError("Animal, small-animal and blank strata are inconsistent")
    if not any(animal) or not any(blank):
        raise ValueError("Need both ground-truth animal and blank images")
    for values in scores.values():
        validate_scores(values)
        if len(values) != len(animal):
            raise ValueError("Model scores and ground truth must align")
    target = mean(
        x >= REFERENCE_THRESHOLD
        for x, is_blank in zip(scores["mdv5a"], blank, strict=True)
        if is_blank
    )
    thresholds = {
        name: (
            REFERENCE_THRESHOLD
            if name == "mdv5a"
            else matched_threshold(
                [x for x, is_blank in zip(values, blank, strict=True) if is_blank], target
            )
        )
        for name, values in scores.items()
    }
    outcomes = {
        name: [score >= thresholds[name] for score in values] for name, values in scores.items()
    }
    report: dict[str, object] = {
        "target_blank_false_detection_rate": target,
        "resamples": RESAMPLES,
        "seed": SEED,
        "resampling_unit": "image",
        "thresholds": thresholds,
    }
    for name, found in outcomes.items():
        strata: dict[str, object] = {}
        for label, mask in (("overall", animal), ("small_animal", small)):
            selected = [value for value, keep in zip(found, mask, strict=True) if keep]
            strata[label] = {
                "n": len(selected),
                "recall": mean(selected) if selected else None,
                "differences": {
                    other: paired_bootstrap(
                        selected,
                        [value for value, keep in zip(other_found, mask, strict=True) if keep],
                    )
                    for other, other_found in outcomes.items()
                    if other != name
                }
                if selected
                else {},
            }
        rate = mean(value for value, keep in zip(found, blank, strict=True) if keep)
        report[name] = {
            "blank_false_detection_rate": rate,
            "blank_count_error": (rate - target) * sum(blank),
            **strata,
        }
    return report
