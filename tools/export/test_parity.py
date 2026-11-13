import numpy as np
import pytest

from export.verify import logit_error
from golden.run_cli import Classifications, Predictions, merge_raw


def test_fp32_tolerance_is_absolute_and_strict() -> None:
    expected = np.array([[10.0, -2.0]], dtype=np.float32)
    assert logit_error(expected, expected.copy(), "same") == 0
    with pytest.raises(ValueError, match="fp32 parity failed"):
        logit_error(expected, expected + np.float32(0.001), "different")


@pytest.mark.parametrize("invalid", [np.nan, np.inf, -np.inf])
def test_nonfinite_logits_fail(invalid: float) -> None:
    with pytest.raises(ValueError, match="Invalid ONNX logits"):
        logit_error(
            np.zeros((1, 1), dtype=np.float32),
            np.array([[invalid]], dtype=np.float32),
            "nonfinite",
        )


def test_output_shape_must_match() -> None:
    with pytest.raises(ValueError, match="Invalid ONNX logits"):
        logit_error(np.zeros((1, 2), dtype=np.float32), np.zeros((2, 1), dtype=np.float32), "shape")


def predictions() -> Predictions:
    return {
        "info": {"format_version": "20261015"},
        "predictions": [
            {
                "filepath": "example.jpg",
                "detections": [{"bbox": [0.1, 0.2, 0.3, 0.4], "conf": 0.9}],
            }
        ],
    }


def test_merge_matches_boxes_and_preserves_top_five() -> None:
    detector = predictions()
    classifier = predictions()
    raw: Classifications = {
        "classes": ["a", "b", "c", "d", "e"],
        "scores": [0.5, 0.2, 0.1, 0.09, 0.08],
    }
    classifier["predictions"][0]["detections"][0]["raw_classifications"] = raw
    merged = merge_raw(detector, classifier)
    assert merged["predictions"][0]["detections"][0].get("raw_classifications") == raw


def test_merge_rejects_mismatched_boxes() -> None:
    classifier = predictions()
    classifier["predictions"][0]["detections"][0]["bbox"][0] = 0.11
    with pytest.raises(ValueError, match="geometry disagrees"):
        merge_raw(predictions(), classifier)


def test_merge_rejects_truncated_classes() -> None:
    classifier = predictions()
    classifier["predictions"][0]["detections"][0]["raw_classifications"] = {
        "classes": ["a", "b"],
        "scores": [0.5, 0.2],
    }
    with pytest.raises(ValueError, match="five raw classes"):
        merge_raw(predictions(), classifier)
