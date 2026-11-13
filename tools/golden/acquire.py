import hashlib
import importlib
import json
import os
import shutil
from collections.abc import Callable
from pathlib import Path
from typing import TypedDict
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
GOLDEN = ROOT / "tests/golden"
MODEL_HANDLE = "google/speciesnet/pyTorch/v4.0.3a/1"
MODEL_DIR = ROOT / ".cache/kagglehub/models" / MODEL_HANDLE
IMAGE_COUNT = 16


class Asset(TypedDict):
    url: str
    bytes: int
    sha256: str


class ImageAsset(Asset):
    name: str


class Provenance(TypedDict):
    commit: str
    files: list[ImageAsset]
    detector: Asset


def verify(path: Path, asset: Asset) -> None:
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if path.stat().st_size != asset["bytes"] or digest != asset["sha256"]:
        raise ValueError(f"Upstream checksum mismatch: {path}")


def acquire(path: Path, asset: Asset) -> None:
    if path.exists():
        verify(path, asset)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(path.suffix + ".part")
    try:
        with urlopen(asset["url"], timeout=600) as response, partial.open("wb") as stream:
            shutil.copyfileobj(response, stream)
        verify(partial, asset)
        partial.replace(path)
    finally:
        partial.unlink(missing_ok=True)


def link(path: Path, target: Path) -> None:
    if path.is_symlink() and path.resolve() == target.resolve():
        return
    if path.exists() or path.is_symlink():
        raise ValueError(f"Expected a cache link at {path}; move the existing path first")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.symlink_to(os.path.relpath(target, path.parent))


def main() -> None:
    record: Provenance = json.loads((GOLDEN / "upstream.provenance.json").read_text())
    if len(record["files"]) != IMAGE_COUNT:
        raise ValueError(f"Expected {IMAGE_COUNT} pinned upstream images")
    images = ROOT / ".cache/upstream/speciesnet" / record["commit"] / "test_data"
    for image in record["files"]:
        acquire(images / image["name"], image)
    detector = ROOT / ".cache/speciesnet/md_v5a.0.1.pt"
    acquire(detector, record["detector"])
    link(GOLDEN / "upstream", images)
    os.environ["KAGGLEHUB_CACHE"] = str(ROOT / ".cache/kagglehub")
    download: Callable[[str], str] = importlib.import_module("kagglehub").model_download
    if Path(download(MODEL_HANDLE)) != MODEL_DIR:
        raise ValueError("Kaggle download did not use the workspace cache")
    # SpeciesNet derives its cached detector filename from the complete source URL.
    filename = record["detector"]["url"].replace(":", "_").replace("/", "_")
    link(MODEL_DIR / filename, detector)
    print(f"Verified {IMAGE_COUNT} upstream JPEGs and official MDv5a weights; cache links ready")


if __name__ == "__main__":
    main()
