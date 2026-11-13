"""Write the depth map the landing page relights the sample's empty frame with.

Run from tools/: `uv run --group onnx python -m sample.depth_master`.

The model runs here, once, never in the browser. Depth Anything V2 Small (Apache-2.0) estimates
relative inverse depth, so near ground is high and the far bank is low. The map is blurred in
float before it is quantised, because the page reads slopes from it and 8-bit steps turn into
grit under a moving light. Each value is stored in 16 bits across the red (high byte) and green
(low byte) channels of a small PNG.
"""

from __future__ import annotations

import argparse
import importlib
from collections.abc import Callable
from pathlib import Path
from typing import Protocol

import numpy as np
from numpy.typing import NDArray
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
# The first frame on the card: an empty burst at 08:02 on 17 June 2011, the camera's own view.
MASTER = ROOT / "public/sample/598acdb6-23d2-11e8-a6a3-ec086b02610b.jpg"
OUTPUT = ROOT / "public/sample/master-depth.png"
MODEL_REPO = "onnx-community/depth-anything-v2-small"
MODEL_FILE = "onnx/model.onnx"
MODEL_SIDE = 518
OUTPUT_WIDTH = 512
BLUR_SIGMA_PX = 1.6
# The branch at the right edge stands far nearer than the ground around it. Capping every row at
# this percentile of its own depths lays the branch level with its ground, so the flash does not
# carve it into a cliff with a bright rim.
ROW_CAP_PERCENTILE = 85
# The burnt-in data strips at the top and bottom of the frame are text, not ground.
STRIP_TOP = 0.03
STRIP_BOTTOM = 0.02
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

Floats = NDArray[np.float32]


class Session(Protocol):
    def run(
        self, output_names: list[str], input_feed: dict[str, Floats]
    ) -> list[NDArray[np.float32]]: ...


class DownloadFile(Protocol):
    def __call__(self, repo_id: str, filename: str) -> str: ...


def model_input(photo: Image.Image) -> Floats:
    """The photo at the model's patch grid, normalised and laid out as one NCHW batch."""
    scale = MODEL_SIDE / min(photo.size)
    size = (round(photo.width * scale / 14) * 14, round(photo.height * scale / 14) * 14)
    pixels = np.asarray(photo.resize(size, Image.Resampling.BICUBIC), dtype=np.float32) / 255
    return ((pixels - IMAGENET_MEAN) / IMAGENET_STD).transpose(2, 0, 1)[None].astype(np.float32)


def gaussian_blur(values: Floats, sigma: float) -> Floats:
    radius = int(3 * sigma + 0.5)
    taps = np.exp(-0.5 * (np.arange(-radius, radius + 1) / sigma) ** 2)
    taps /= taps.sum()
    padded = np.pad(values, radius, mode="edge")
    rows = np.apply_along_axis(lambda row: np.convolve(row, taps, mode="valid"), 1, padded)
    return np.apply_along_axis(lambda col: np.convolve(col, taps, mode="valid"), 0, rows).astype(
        np.float32
    )


def flatten_strips(values: Floats) -> Floats:
    """Copies the nearest ground row over each data strip, so no slope is read from text."""
    out = values.copy()
    top = max(1, round(STRIP_TOP * len(out)))
    bottom = len(out) - max(1, round(STRIP_BOTTOM * len(out)))
    out[:top] = out[top]
    out[bottom:] = out[bottom - 1]
    return out


def cap_rows(values: Floats) -> Floats:
    cap = np.percentile(values, ROW_CAP_PERCENTILE, axis=1, keepdims=True)
    return np.minimum(values, cap).astype(np.float32)


def normalise(values: Floats) -> Floats:
    low, high = np.percentile(values, [1, 99])
    return np.clip((values - low) / (high - low), 0, 1).astype(np.float32)


def pack16(values: Floats) -> NDArray[np.uint8]:
    """Values in [0, 1] as RGB bytes: red the high byte, green the low byte, blue zero."""
    quantised = np.round(np.clip(values, 0, 1) * 65535).astype(np.uint32)
    packed = np.zeros((*values.shape, 3), dtype=np.uint8)
    packed[..., 0] = quantised >> 8
    packed[..., 1] = quantised & 0xFF
    return packed


def unpack16(packed: NDArray[np.uint8]) -> Floats:
    return ((packed[..., 0].astype(np.float32) * 256 + packed[..., 1]) / 65535).astype(np.float32)


def depth_map(photo: Image.Image, session: Session) -> Floats:
    (raw,) = session.run(["predicted_depth"], {"pixel_values": model_input(photo)})
    disparity = np.asarray(raw, dtype=np.float32)[0]
    height = round(OUTPUT_WIDTH * photo.height / photo.width)
    resized = Image.fromarray(disparity).resize((OUTPUT_WIDTH, height), Image.Resampling.BICUBIC)
    flat = cap_rows(flatten_strips(np.asarray(resized, np.float32)))
    return normalise(gaussian_blur(flat, BLUR_SIGMA_PX))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--photo", type=Path, default=MASTER)
    parser.add_argument("--out", type=Path, default=OUTPUT)
    args = parser.parse_args()
    download: DownloadFile = importlib.import_module("huggingface_hub").hf_hub_download
    session_type: Callable[..., Session] = importlib.import_module("onnxruntime").InferenceSession
    session = session_type(download(MODEL_REPO, MODEL_FILE), providers=["CPUExecutionProvider"])
    with Image.open(args.photo) as image:
        depth = depth_map(image.convert("RGB"), session)
    Image.fromarray(pack16(depth), "RGB").save(args.out, optimize=True)
    print(f"{args.out.relative_to(ROOT)}: {depth.shape[1]}x{depth.shape[0]}")


if __name__ == "__main__":
    main()
