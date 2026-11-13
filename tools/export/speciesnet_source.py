import hashlib
import json
from pathlib import Path
from typing import TypedDict

ROOT = Path(__file__).resolve().parents[2]
MODEL_HANDLE = "google/speciesnet/pyTorch/v4.0.3a/1"
MODEL_DIR = ROOT / ".cache/kagglehub/models" / MODEL_HANDLE
EXPORT_DIR = ROOT / ".cache/exports/speciesnet-v4.0.3a"
REFERENCE_DIR = ROOT / ".cache/speciesnet-reference"
RAW_PATH = ROOT / "tests/golden/speciesnet_cli.raw.json"
IMAGE_SIZE = 480
LABEL_COUNT = 2498
IMAGE_COUNT = 16
TOP_K = 5
FP32_TOLERANCE = 1e-4
# Measured from Kaggle model version 1; acquisition evidence is in docs/classifier-export.md.
SOURCE_SHA256 = {
    "always_crop_99710272_22x8_v12_epoch_00148.pt": (
        "d099632044e92a0446869e06e5eb282e24706d5266b4acf5b42f5f23e2b50ade"
    ),
    "always_crop_99710272_22x8_v12_epoch_00148.labels.20260609.txt": (
        "e0c41415d9b29dfd6d2e2494205d1197d28595cc6f69cb129495f9827155547e"
    ),
    "taxonomy_release.20260609.txt": (
        "4bd5d1a85a63857f557d487c5d86c0911173c59b34977ebc0ee909484ce277f2"
    ),
    "geofence_release.20260609.json": (
        "27a88e932e411f73a4937c935fe36cf61a9060a1c488f4c69ade3f19eb8507d1"
    ),
    "info.json": ("037133d121d48a5cd53884cdee01374564f32e2cc6f1375ffb39a9bc1cf6000a"),
    "README.md": ("5707c487b20aef8bb779d63c32d8ca11ee7d66c12e46ff4a366047622bf49811"),
}


class ModelInfo(TypedDict):
    version: str
    type: str
    classifier: str
    classifier_labels: str
    taxonomy: str
    geofence: str
    detector: str


class Integrity(TypedDict):
    bytes: int
    sha256: str


class Reference(TypedDict):
    speciesnet_pypi: str
    torch: str
    seed: int
    device: str
    golden_images: int
    golden_crops: int
    cases: list[str]
    raw_golden: Integrity
    checkpoint: Integrity
    fp32: Integrity
    fixtures: list[Integrity]
    images: dict[str, Integrity]


def read_info() -> ModelInfo:
    for filename, expected in SOURCE_SHA256.items():
        if integrity(MODEL_DIR / filename)["sha256"] != expected:
            raise ValueError(f"Pinned Kaggle source checksum mismatch: {filename}")
    info: ModelInfo = json.loads((MODEL_DIR / "info.json").read_text())
    if info["version"] != "4.0.3a" or info["type"] != "always_crop":
        raise ValueError(f"Expected the pinned v4.0.3a crop classifier, got {info}")
    for key in ("classifier", "classifier_labels", "taxonomy", "geofence"):
        filename = info[key]
        if Path(filename).name != filename or not (MODEL_DIR / filename).is_file():
            raise ValueError(f"Missing or invalid model asset: {filename}")
    return info


def integrity(path: Path) -> Integrity:
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return {"bytes": path.stat().st_size, "sha256": digest}
