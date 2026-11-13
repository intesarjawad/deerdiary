"""Write seeded 4000x3000 Lanczos upscales of a trail-camera card.

Low-megapixel cards understate decode cost: a full-resolution photo still has to reach
12 MP worth of pixels before the detector sees it. This tool reads the card once, then
writes a deterministic set of upscales for the long benchmark run.
"""

from __future__ import annotations

import argparse
import random
from pathlib import Path

from PIL import Image

TARGET_SIZE = (4000, 3000)
DEFAULT_COUNT = 1000
DEFAULT_SEED = 0
PHOTO_EXTENSIONS = {".jpg", ".jpeg"}


def card_photos(directory: Path) -> list[Path]:
    photos = sorted(
        path
        for path in directory.rglob("*")
        if path.is_file() and path.suffix.lower() in PHOTO_EXTENSIONS
    )
    if not photos:
        raise SystemExit(f"No JPEG photos in {directory}")
    return photos


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path("tools/bench/data/card"))
    parser.add_argument("--output", type=Path, default=Path(".cache/bench/card-12mp"))
    parser.add_argument("--count", type=int, default=DEFAULT_COUNT)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    args = parser.parse_args()
    if args.count < 1:
        raise SystemExit("--count must be positive")

    photos = card_photos(args.source)
    order = list(photos)
    random.Random(args.seed).shuffle(order)
    args.output.mkdir(parents=True, exist_ok=True)
    for index in range(args.count):
        source = order[index % len(order)]
        with Image.open(source) as image:
            image.load()
            upscaled = image.convert("RGB").resize(TARGET_SIZE, Image.Resampling.LANCZOS)
            upscaled.save(args.output / f"upscaled-{index:05d}.jpg", quality=95)
        if index % 100 == 0:
            print(f"{index}/{args.count}: {source.name}")
    print(f"Wrote {args.count} seeded upscales to {args.output}")


if __name__ == "__main__":
    main()
