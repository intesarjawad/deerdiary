"""Write and check the photos of the instant sample in public/sample/.

The sample ships with the site, so each photo is downsized and carries no metadata beyond its
capture time: no GPS position, no maker notes, no camera serial number.
"""

from __future__ import annotations

import argparse
from datetime import datetime
from pathlib import Path

from PIL import Image

SAMPLE_PHOTO_COUNT = 60
SAMPLE_BUDGET_BYTES = 15_000_000
LONG_SIDE_PX = 1600
# Quality 85 put 60 noisy infrared night frames at 21 MB; 72 with optimised tables fits.
JPEG_QUALITY = 72
EXIF_IFD = 0x8769
GPS_IFD = 0x8825
DATE_TIME_ORIGINAL = 0x9003
EXIF_TIME_FORMAT = "%Y:%m:%d %H:%M:%S"


def sample_photos(directory: Path) -> list[Path]:
    return sorted(path for path in directory.glob("*.jpg") if path.is_file())


def write_sample_photo(source: Path, target: Path, captured: datetime) -> None:
    """Downsizes `source` to the sample size and writes `captured` as its only EXIF field."""
    with Image.open(source) as image:
        photo = image.convert("RGB")
    photo.thumbnail((LONG_SIDE_PX, LONG_SIDE_PX), Image.Resampling.LANCZOS)
    exif = Image.Exif()
    exif[EXIF_IFD] = {DATE_TIME_ORIGINAL: captured.strftime(EXIF_TIME_FORMAT)}
    target.parent.mkdir(parents=True, exist_ok=True)
    photo.save(target, quality=JPEG_QUALITY, optimize=True, exif=exif)


def photo_problems(path: Path) -> list[str]:
    with Image.open(path) as image:
        tags = set(image.getexif())
        long_side = max(image.size)
    problems: list[str] = []
    if GPS_IFD in tags:
        problems.append(f"{path.name} has GPS tags")
    if EXIF_IFD not in tags:
        problems.append(f"{path.name} has no EXIF capture time")
    # Make, model and serial number live beside the pointer to the EXIF IFD.
    if camera_tags := tags - {EXIF_IFD, GPS_IFD}:
        problems.append(f"{path.name} keeps camera tags {sorted(camera_tags)}")
    if long_side > LONG_SIDE_PX:
        problems.append(f"{path.name} is {long_side} px on its long side, over {LONG_SIDE_PX}")
    return problems


def sample_problems(directory: Path) -> list[str]:
    """Everything that keeps `directory` from shipping as the sample; empty when it may ship."""
    photos = sample_photos(directory)
    problems: list[str] = []
    if len(photos) != SAMPLE_PHOTO_COUNT:
        problems.append(f"{len(photos)} photos, expected {SAMPLE_PHOTO_COUNT}")
    total_bytes = sum(path.stat().st_size for path in photos)
    if total_bytes >= SAMPLE_BUDGET_BYTES:
        problems.append(f"photos total {total_bytes:,} bytes, budget {SAMPLE_BUDGET_BYTES:,}")
    provenance = directory / "PROVENANCE.txt"
    if not provenance.is_file() or provenance.stat().st_size == 0:
        problems.append("PROVENANCE.txt is missing or empty")
    for path in photos:
        problems.extend(photo_problems(path))
    return problems


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", type=Path, required=True, metavar="DIR")
    args = parser.parse_args()
    problems = sample_problems(args.check)
    if problems:
        raise SystemExit("\n".join(f"{args.check}: {problem}" for problem in problems))
    photos = sample_photos(args.check)
    total_bytes = sum(path.stat().st_size for path in photos)
    print(f"{args.check}: {len(photos)} photos, {total_bytes:,} bytes, no GPS tags")


if __name__ == "__main__":
    main()
