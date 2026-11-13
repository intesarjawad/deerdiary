import base64
import gzip
import json
from pathlib import Path

import numpy as np
from numpy.typing import NDArray
from PIL import Image, ImageOps

from export.reference import crop_pixels
from golden.acquire import Provenance, verify

ROOT = Path(__file__).resolve().parents[2]
BOXES = [
    [0.0, 0.0, 1.0, 1.0],
    [0.123, 0.234, 0.567, 0.543],
    [0.49, 0.48, 0.013, 0.021],
    [-0.017, -0.023, 0.21, 0.19],
    [0.91, 0.89, 0.2, 0.23],
]
NAMES = ("african_elephants.jpg", "human_and_dog.jpg", "vehicle.jpg")
SIZE = 640


def encode(pixels: NDArray[np.uint8]) -> str:
    flat = pixels.reshape(-1)
    # Channel differencing keeps full-resolution golden pixels compact without a JPEG decoder.
    delta = flat.copy()
    delta[3:] = flat[3:] - flat[:-3]
    return base64.b64encode(gzip.compress(delta.tobytes(), mtime=0)).decode("ascii")


def main() -> None:
    provenance: Provenance = json.loads(
        (ROOT / "tests/golden/upstream.provenance.json").read_text()
    )
    images: list[dict[str, object]] = []
    for name in NAMES:
        asset = next(asset for asset in provenance["files"] if asset["name"] == name)
        path = ROOT / "tests/golden/upstream" / name
        verify(path, asset)
        with Image.open(path) as source:
            image = source.convert("RGB")
            ImageOps.exif_transpose(image, in_place=True)
        pixels = np.asarray(image, dtype=np.uint8)
        images.append(
            {
                "name": name,
                "width": image.width,
                "height": image.height,
                "rgb": encode(pixels),
                "crops": [{"bbox": box, "rgb": encode(crop_pixels(image, box))} for box in BOXES],
                "pil640": encode(
                    np.asarray(
                        image.resize((SIZE, SIZE), Image.Resampling.BILINEAR), dtype=np.uint8
                    )
                ),
            }
        )
    destination = ROOT / "tests/golden/resize_torchvision.json"
    destination.write_text(
        json.dumps(
            {
                "torch": "2.15.0",
                "torchvision": "0.29.2",
                "upstream_commit": provenance["commit"],
                "encoding": "base64 gzip channel-delta-3 RGB uint8 HWC",
                "crop_size": 480,
                "pil_size": SIZE,
                "images": images,
            },
            indent=2,
        )
        + "\n"
    )
    print(f"Wrote {len(images) * len(BOXES)} torchvision crops and {len(images)} PIL images")


if __name__ == "__main__":
    main()
