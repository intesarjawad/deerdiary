import pytest

from eval.selection import compare_models, matched_threshold, paired_bootstrap


def test_matched_threshold_reproduces_rate_within_one_blank() -> None:
    scores = [i / 100 for i in range(100)]
    threshold = matched_threshold(scores, 0.23)
    assert abs(sum(x >= threshold for x in scores) - 23) <= 1


def test_tied_scores_report_unattainable_target_conservatively() -> None:
    threshold = matched_threshold([0.5] * 10, 0.5)
    assert sum(x >= threshold for x in [0.5] * 10) == 0


def test_bootstrap_is_paired_and_reproducible() -> None:
    left, right = [True, False, True], [False, True, True]
    assert paired_bootstrap(left, right) == paired_bootstrap(left, right)
    interval = paired_bootstrap(left, left)
    assert interval["lower"] <= 0 <= interval["upper"]
    assert interval["difference"] == 0


def test_recall_uses_animal_strata_and_separate_blank_pool() -> None:
    report = compare_models(
        {"mdv5a": [0.1, 0.4, 0.4, 0.0], "rtdetr": [0.01, 0.9, 0.9, 0.0]},
        [True, True, False, False],
        [True, False, False, False],
        [False, False, True, True],
    )
    assert report["thresholds"] == {"mdv5a": 0.2, "rtdetr": 0.9}
    zero = {"difference": 0.0, "lower": 0.0, "upper": 0.0}
    assert report["rtdetr"] == {
        "blank_false_detection_rate": 0.5,
        "blank_count_error": 0.0,
        "overall": {"n": 2, "recall": 0.5, "differences": {"mdv5a": zero}},
        "small_animal": {"n": 1, "recall": 0.0, "differences": {"mdv5a": zero}},
    }
    assert report["target_blank_false_detection_rate"] == 0.5


@pytest.mark.parametrize("scores", [[], [float("nan")], [-0.1], [1.1]])
def test_invalid_scores_fail(scores: list[float]) -> None:
    with pytest.raises(ValueError, match="finite probabilities"):
        matched_threshold(scores, 0.2)


def test_zero_scores_represent_absent_detections() -> None:
    threshold = matched_threshold([0.0, 0.0], 0.0)
    assert threshold > 0
    assert sum(value >= threshold for value in [0.0, 0.0]) == 0
