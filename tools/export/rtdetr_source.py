import shutil
from pathlib import Path
from typing import TypedDict

from export.speciesnet_source import ROOT, Integrity

MODEL_NAME = "MDV6-apa-rtdetr-c"
CHECKPOINT = ROOT / ".cache/rtdetr" / f"{MODEL_NAME}.pth"
CHECKPOINT_URL = f"https://zenodo.org/records/15398270/files/{MODEL_NAME}.pth"
EXPORT_DIR = ROOT / ".cache/exports" / MODEL_NAME
REFERENCE_DIR = ROOT / ".cache/rtdetr-reference"
IMAGE_SIZE = 640
QUERY_COUNT = 300
CLASS_COUNT = 3
IMAGE_COUNT = 16
SEED = 20261104
OPSET = 17
MIN_FREE_BYTES = 30 * 1024**3
MIN_IOU = 0.99
CONF_TOLERANCE = 1e-3
CHECKPOINT_INTEGRITY: Integrity = {
    "bytes": 322443686,
    "sha256": "4814cdbc9a0dbf20e4b04495f060176d8340b00d182fc98ce808a4d14a2a6fce",
}


class Reference(TypedDict):
    pytorchwildlife: str
    torch: str
    device: str
    seed: int
    opset: int
    postprocessing: bool
    cases: list[str]
    golden_provenance: Integrity
    images: dict[str, Integrity]
    checkpoint: Integrity
    source_files: dict[str, Integrity]
    fp32: Integrity
    fixtures: list[Integrity]


def require_disk_space() -> None:
    free = shutil.disk_usage(ROOT).free
    if free < MIN_FREE_BYTES:
        raise OSError(f"Stop: {free / 1024**3:.1f} GiB free; at least 30 GiB required")


def model_path(precision: str) -> Path:
    return EXPORT_DIR / f"{MODEL_NAME}.{precision}.onnx"
