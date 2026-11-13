import importlib
import wave
from collections.abc import Callable
from pathlib import Path

import numpy as np
import pytest
from numpy.typing import NDArray
from onnx import TensorProto, helper

from golden import perch_reference
from golden.perch_reference import WINDOW


class Scripted:
    """Answers each call with a one-hot label row for the next scripted class."""

    def __init__(self, classes: list[int]) -> None:
        self.classes = classes
        self.calls = 0

    def run(
        self, output_names: list[str], input_feed: dict[str, NDArray[np.float32]]
    ) -> list[NDArray[np.float32]]:
        assert output_names == ["label"]
        assert input_feed["inputs"].shape == (1, WINDOW)
        row = np.zeros((1, 4), dtype=np.float32)
        row[0, self.classes[self.calls]] = 1
        self.calls += 1
        return [row]


def write_wav(path: Path, samples: list[int], rate: int = 32_000, channels: int = 1) -> None:
    with wave.open(str(path), "wb") as clip:
        clip.setnchannels(channels)
        clip.setsampwidth(2)
        clip.setframerate(rate)
        clip.writeframes(np.array(samples, dtype="<i2").tobytes())


def padded(head: list[int], length: int = WINDOW) -> list[int]:
    return head + [0] * (length - len(head))


def test_read_clip_scales_sixteen_bit_samples(tmp_path: Path) -> None:
    write_wav(tmp_path / "clip.wav", [0, 16384, -32768])
    np.testing.assert_array_equal(
        perch_reference.read_clip(tmp_path / "clip.wav"), np.array([0, 0.5, -1], dtype=np.float32)
    )


@pytest.mark.parametrize(("rate", "channels"), [(44_100, 1), (32_000, 2)])
def test_read_clip_rejects_other_formats(tmp_path: Path, rate: int, channels: int) -> None:
    write_wav(tmp_path / "clip.wav", [0, 0], rate=rate, channels=channels)
    with pytest.raises(ValueError, match="mono 16-bit"):
        perch_reference.read_clip(tmp_path / "clip.wav")


def test_windows_are_consecutive_and_drop_the_incomplete_tail() -> None:
    samples = np.arange(2 * WINDOW + 10, dtype=np.float32)
    result = perch_reference.windows(samples)
    assert len(result) == 2
    assert result[0].shape == (1, WINDOW)
    assert result[1][0, 0] == WINDOW
    assert result[1][0, -1] == 2 * WINDOW - 1


def test_compare_counts_windows_with_the_same_top_label() -> None:
    clips = [
        ("a.wav", np.zeros(2 * WINDOW, dtype=np.float32)),
        ("b.wav", np.zeros(2 * WINDOW + 5, dtype=np.float32)),
    ]
    result = perch_reference.compare(Scripted([0, 1, 2, 1]), Scripted([0, 1, 0, 1]), clips)
    assert (result.windows, result.agreeing) == (4, 3)
    assert result.rate == 0.75


def test_compare_rejects_a_clip_shorter_than_a_window() -> None:
    clips = [("short.wav", np.zeros(WINDOW - 1, dtype=np.float32))]
    with pytest.raises(ValueError, match=r"short\.wav is shorter"):
        perch_reference.compare(Scripted([0]), Scripted([0]), clips)


def test_compare_rejects_non_finite_labels() -> None:
    class Broken(Scripted):
        def run(
            self, output_names: list[str], input_feed: dict[str, NDArray[np.float32]]
        ) -> list[NDArray[np.float32]]:
            return [np.full((1, 4), np.nan, dtype=np.float32)]

    clips = [("nan.wav", np.zeros(WINDOW, dtype=np.float32))]
    with pytest.raises(ValueError, match=r"Invalid Perch labels: nan\.wav window 0"):
        perch_reference.compare(Scripted([0]), Broken([0]), clips)


def index_tensor(name: str, value: int) -> TensorProto:
    make_tensor: Callable[..., TensorProto] = importlib.import_module("onnx.helper").make_tensor
    return make_tensor(
        name, TensorProto.INT64, [1], np.array([value], dtype="<i8").tobytes(), raw=True
    )


def slice_model(path: Path, start: int) -> None:
    """A graph whose label is the three samples from start, so its top-1 is easy to derive."""
    graph = helper.make_graph(
        [
            helper.make_node("Slice", ["inputs", "starts", "ends", "axes"], ["label"]),
        ],
        "slice",
        [helper.make_tensor_value_info("inputs", TensorProto.FLOAT, ["batch", WINDOW])],
        [helper.make_tensor_value_info("label", TensorProto.FLOAT, ["batch", 3])],
        initializer=[
            index_tensor("starts", start),
            index_tensor("ends", start + 3),
            index_tensor("axes", 1),
        ],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)], ir_version=10)
    path.write_bytes(model.SerializeToString())


@pytest.fixture
def clips(tmp_path: Path) -> Path:
    folder = tmp_path / "clips"
    folder.mkdir()
    # Spike at sample 0, 1 and 2: the graph reading samples 0-2 puts its top-1 on 0, 1 and 2;
    # the graph reading samples 1-3 puts it on 0, 0 and 1.
    for name, spike in (("a.wav", 0), ("b.wav", 1), ("c.wav", 2)):
        samples = [0] * 4
        samples[spike] = 16384
        write_wav(folder / name, padded(samples))
    return folder


def test_check_runs_both_onnx_graphs_over_every_golden_window(tmp_path: Path, clips: Path) -> None:
    fp32 = tmp_path / "fp32.onnx"
    same = tmp_path / "same.onnx"
    shifted = tmp_path / "shifted.onnx"
    slice_model(fp32, 0)
    slice_model(same, 0)
    slice_model(shifted, 1)

    result = perch_reference.check(fp32, same, clips)
    assert (result.windows, result.agreeing) == (3, 3)

    with pytest.raises(ValueError, match=r"agreement 0\.3333 is below 0\.95 \(1 of 3 windows\)"):
        perch_reference.check(fp32, shifted, clips)


def test_check_accepts_exactly_the_agreement_floor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    folder = tmp_path / "clips"
    folder.mkdir()
    for name, windows in (("a.wav", 7), ("b.wav", 7), ("c.wav", 6)):
        write_wav(folder / name, [0] * (windows * WINDOW))
    for name in ("fp32", "fp16"):
        (tmp_path / f"{name}.onnx").touch()
    sessions = {"fp32.onnx": Scripted([0] * 20), "fp16.onnx": Scripted([1] + [0] * 19)}

    def open_session(path: Path) -> Scripted:
        return sessions[path.name]

    monkeypatch.setattr(perch_reference, "open_session", open_session)

    result = perch_reference.check(tmp_path / "fp32.onnx", tmp_path / "fp16.onnx", folder)

    assert (result.windows, result.agreeing) == (20, 19)
    assert result.rate == 0.95


def test_check_requires_three_clips_and_both_graphs(tmp_path: Path, clips: Path) -> None:
    (clips / "c.wav").unlink()
    with pytest.raises(ValueError, match="Expected 3 golden clips"):
        perch_reference.check(tmp_path / "a.onnx", tmp_path / "b.onnx", clips)
    write_wav(clips / "c.wav", padded([]))
    with pytest.raises(ValueError, match="Missing Perch graph"):
        perch_reference.check(tmp_path / "a.onnx", tmp_path / "b.onnx", clips)
