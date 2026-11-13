import json

import numpy as np
from PIL import Image, ImageFile, ImageOps

from eval.prepare_selection import letterbox
from export.rtdetr_source import IMAGE_COUNT, REFERENCE_DIR, Reference
from export.speciesnet_source import ROOT, integrity


def main() -> None:
    record: Reference = json.loads((REFERENCE_DIR / "reference.json").read_text())
    destination = ROOT / ".cache/detector-sorrel"
    destination.mkdir(parents=True, exist_ok=True)
    ImageFile.LOAD_TRUNCATED_IMAGES = True
    cases: list[dict[str, object]] = []
    for index, name in enumerate(record["cases"][:IMAGE_COUNT]):
        source = ROOT / name
        if integrity(source) != record["images"][name]:
            raise ValueError(f"Stale golden image: {source}")
        with Image.open(source) as original:
            image = original.convert("RGB")
            ImageOps.exif_transpose(image, in_place=True)
        tensor = destination / f"sorrel-{index:03}.bin"
        tensor.write_bytes(letterbox(image, 960).astype(np.dtype("<f4")).tobytes())
        cases.append({"name": name, "url": tensor.name, **integrity(tensor)})
    (destination / "fixtures.json").write_text(json.dumps({"cases": cases}) + "\n")
    print(f"Prepared {len(cases)} sorrel image tensors in {destination}")


if __name__ == "__main__":
    main()
