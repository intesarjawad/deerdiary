import argparse
import importlib
import wave
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import NamedTuple, Protocol

import numpy as np
from numpy.typing import NDArray

ROOT = Path(__file__).resolve().parents[2]
CLIPS_DIR = ROOT / "tests/golden/perch"
EXPORT_DIR = ROOT / ".cache/exports/perch"
FP32_PATH = EXPORT_DIR / "perch_v2_no_dft.fp32.onnx"
FP16_PATH = EXPORT_DIR / "perch_v2_no_dft.fp16.onnx"
SAMPLE_RATE = 32_000
WINDOW = 5 * SAMPLE_RATE
CLIP_COUNT = 3
MINIMUM_AGREEMENT = 0.95
INPUT_NAME = "inputs"
LABEL_OUTPUT = "label"
PCM_WIDTH = 2
LABEL_RANK = 2


class Agreement(NamedTuple):
    windows: int
    agreeing: int

    @property
    def rate(self) -> float:
        return self.agreeing / self.windows


class Session(Protocol):
    def run(
        self, output_names: list[str], input_feed: dict[str, NDArray[np.float32]]
    ) -> list[NDArray[np.float32]]: ...


def read_clip(path: Path) -> NDArray[np.float32]:
    """Reads a 32 kHz mono 16-bit WAV as floats in [-1, 1); other formats are not resampled."""
    with wave.open(str(path), "rb") as clip:
        if (clip.getframerate(), clip.getnchannels(), clip.getsampwidth()) != (
            SAMPLE_RATE,
            1,
            PCM_WIDTH,
        ):
            raise ValueError(f"Expected {SAMPLE_RATE} Hz mono 16-bit PCM: {path.name}")
        frames = clip.readframes(clip.getnframes())
    return np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768


def windows(samples: NDArray[np.float32]) -> list[NDArray[np.float32]]:
    """Splits into consecutive five-second windows; an incomplete tail is dropped."""
    count = len(samples) // WINDOW
    return [samples[index * WINDOW : (index + 1) * WINDOW][np.newaxis] for index in range(count)]


def top_label(session: Session, window: NDArray[np.float32], name: str) -> int:
    labels = session.run([LABEL_OUTPUT], {INPUT_NAME: window})[0]
    if labels.ndim != LABEL_RANK or labels.shape[0] != 1 or not np.isfinite(labels).all():
        raise ValueError(f"Invalid Perch labels: {name}")
    return int(np.argmax(labels[0]))


def compare(
    fp32: Session, fp16: Session, clips: Sequence[tuple[str, NDArray[np.float32]]]
) -> Agreement:
    """Counts the windows whose top-1 label is the same in both graphs."""
    total = 0
    agreeing = 0
    for name, samples in clips:
        clip_windows = windows(samples)
        if not clip_windows:
            raise ValueError(f"{name} is shorter than one {WINDOW}-sample window")
        for index, window in enumerate(clip_windows):
            label = f"{name} window {index}"
            total += 1
            agreeing += top_label(fp32, window, label) == top_label(fp16, window, label)
    return Agreement(total, agreeing)


def open_session(path: Path) -> Session:
    session_type: Callable[..., Session] = importlib.import_module("onnxruntime").InferenceSession
    return session_type(str(path), providers=["CPUExecutionProvider"])


def check(fp32: Path, fp16: Path, clips_dir: Path, minimum: float = MINIMUM_AGREEMENT) -> Agreement:
    """Runs both graphs on every window of the golden clips and enforces the agreement floor."""
    paths = sorted(clips_dir.glob("*.wav"))
    if len(paths) != CLIP_COUNT:
        raise ValueError(f"Expected {CLIP_COUNT} golden clips in {clips_dir}, found {len(paths)}")
    for path in (fp32, fp16):
        if not path.is_file():
            raise ValueError(f"Missing Perch graph: {path}; run export/fp16.py perch first")
    result = compare(
        open_session(fp32), open_session(fp16), [(path.name, read_clip(path)) for path in paths]
    )
    if result.rate < minimum:
        raise ValueError(
            f"fp16 top-1 agreement {result.rate:.4f} is below {minimum} "
            f"({result.agreeing} of {result.windows} windows)"
        )
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare fp16 Perch with fp32 on golden clips.")
    parser.add_argument("--check", action="store_true", required=True)
    parser.add_argument("--fp32", type=Path, default=FP32_PATH)
    parser.add_argument("--fp16", type=Path, default=FP16_PATH)
    parser.add_argument("--clips", type=Path, default=CLIPS_DIR)
    arguments = parser.parse_args()
    try:
        result = check(arguments.fp32, arguments.fp16, arguments.clips)
    except ValueError as error:
        raise SystemExit(f"FAIL: {error}") from error
    print(
        f"PASS: {CLIP_COUNT} clips, {result.windows} windows, "
        f"fp16 top-1 agreement {result.rate:.4f} >= {MINIMUM_AGREEMENT}"
    )


if __name__ == "__main__":
    main()
