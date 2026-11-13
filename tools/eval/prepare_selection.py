import argparse
import importlib
import json
import math
import random
from collections import defaultdict
from collections.abc import Callable
from pathlib import Path
from typing import TypedDict

import numpy as np
from numpy.typing import NDArray
from PIL import Image, ImageOps

from export.rtdetr_source import require_disk_space
from export.speciesnet_source import integrity

MINIMUM_ENA_BLANKS = 200
CCT_BLANKS = 300
SMALL_ANIMAL_AREA = 0.01


class Annotation(TypedDict):
    image_id: int | str
    category_id: int
    bbox: list[float]


class CocoImage(TypedDict):
    id: int | str
    file_name: str
    width: int
    height: int


class Coco(TypedDict):
    images: list[CocoImage]
    annotations: list[Annotation]


def letterbox(image: Image.Image, side: int) -> NDArray[np.float32]:
    width, height = image.size
    scale = min(side / width, side / height)
    target = (round(width * scale), round(height * scale))
    cv = importlib.import_module("cv2")
    resize: Callable[..., NDArray[np.uint8]] = cv.resize
    resized = resize(np.asarray(image), target, interpolation=cv.INTER_LINEAR)
    pixels = np.full((side, side, 3), 114, dtype=np.uint8)
    left = round((side - target[0]) / 2 - 0.1)
    top = round((side - target[1]) / 2 - 0.1)
    pixels[top : top + target[1], left : left + target[0]] = resized
    return pixels.astype(np.float32).transpose(2, 0, 1)[None] / np.float32(255)


def candidates(metadata: Coco, animal_ids: set[int], empty_id: int) -> list[dict[str, object]]:
    annotations: dict[int | str, list[Annotation]] = defaultdict(list)
    for item in metadata["annotations"]:
        annotations[item["image_id"]].append(item)
    result: list[dict[str, object]] = []
    for image in metadata["images"]:
        labels = annotations[image["id"]]
        animals = [label for label in labels if label["category_id"] in animal_ids]
        blank = bool(labels) and all(label["category_id"] == empty_id for label in labels)
        if not animals and not blank:
            continue
        areas = [
            label["bbox"][2] * label["bbox"][3] / (image["width"] * image["height"])
            for label in animals
        ]
        if any(not math.isfinite(area) or area <= 0 or area > 1 for area in areas):
            raise ValueError(f"Invalid animal box area: {image['file_name']}")
        result.append(
            {
                "path": image["file_name"],
                "animal": bool(animals),
                "small": bool(areas) and max(areas) < SMALL_ANIMAL_AREA,
                "blank": blank,
                "stratum": str(min(label["category_id"] for label in animals))
                if animals
                else "blank",
            }
        )
    return result


def sample(rows: list[dict[str, object]], n: int, cap: int, seed: int) -> list[dict[str, object]]:
    randomizer = random.Random(seed)
    groups: dict[str, list[dict[str, object]]] = defaultdict(list)
    for row in sorted(rows, key=lambda row: str(row["path"])):
        groups[str(row["stratum"])].append(row)
    for group in groups.values():
        randomizer.shuffle(group)
        del group[cap:]
    selected: list[dict[str, object]] = []
    while len(selected) < n and any(groups.values()):
        for key in sorted(groups):
            if groups[key] and len(selected) < n:
                selected.append(groups[key].pop())
    if len(selected) != n:
        raise ValueError(f"Only {len(selected)} eligible images under cap {cap}; requested {n}")
    return selected


def write_list(rows: list[tuple[dict[str, object], Path, str]], dataset: str, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    for row, root, source in rows:
        if source == dataset:
            path = root / str(row["path"])
            lines.append(f"{integrity(path)['sha256']}  {row['path']}\n")
    out.write_text("".join(lines))


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare local COCO camera-trap selection tensors")
    parser.add_argument("--ena-annotations", type=Path, required=True)
    parser.add_argument("--ena-images", type=Path, required=True)
    parser.add_argument("--cct-annotations", type=Path)
    parser.add_argument("--cct-images", type=Path)
    parser.add_argument("--animal-ids", required=True, help="Comma-separated ENA24 category IDs")
    parser.add_argument("--empty-id", type=int, required=True)
    parser.add_argument("--cct-empty-id", type=int)
    parser.add_argument("--per-class-cap", type=int, required=True)
    parser.add_argument("--n", type=int, default=1000)
    parser.add_argument("--seed", type=int, default=20261104)
    parser.add_argument("--list-out", type=Path, default=Path("eval/lists/selection_1000.txt"))
    parser.add_argument("--cct-list-out", type=Path, default=Path("eval/lists/cct_blank_300.txt"))
    parser.add_argument("--out", type=Path, default=Path("../.cache/detector-selection"))
    args = parser.parse_args()
    if args.n < 1 or args.per_class_cap < 1:
        parser.error("n and per-class-cap must be positive")
    animal_ids = {int(value) for value in args.animal_ids.split(",")}
    if args.empty_id in animal_ids:
        parser.error("empty-id must not be an animal category")
    metadata: Coco = json.loads(args.ena_annotations.read_text())
    selected = sample(
        candidates(metadata, animal_ids, args.empty_id), args.n, args.per_class_cap, args.seed
    )
    rows = [(row, args.ena_images, "ENA24") for row in selected]
    blanks = sum(row["blank"] is True for row in selected)
    if blanks < MINIMUM_ENA_BLANKS:
        if args.cct_annotations is None or args.cct_images is None or args.cct_empty_id is None:
            parser.error(
                f"ENA24 sample has {blanks} blanks; supply CCT annotations, images and empty ID"
            )
        cct: Coco = json.loads(args.cct_annotations.read_text())
        cct_rows = sample(
            candidates(cct, set(), args.cct_empty_id), CCT_BLANKS, CCT_BLANKS, args.seed
        )
        rows.extend((row, args.cct_images, "CCT") for row in cct_rows)
    args.out.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, object]] = []
    for index, (row, root, dataset) in enumerate(rows):
        require_disk_space()
        path = (root / str(row["path"])).resolve()
        if not path.is_relative_to(root.resolve()):
            raise ValueError(f"Image escapes dataset root: {path}")
        with Image.open(path) as source:
            image = source.convert("RGB")
            ImageOps.exif_transpose(image, in_place=True)
        tensor_path = args.out / f"{index:04}.npz"
        stretched = image.resize((640, 640), Image.Resampling.BILINEAR)
        np.savez_compressed(
            tensor_path,
            rtdetr=np.asarray(stretched, dtype=np.float32).transpose(2, 0, 1)[None]
            / np.float32(255),
            orig_target_sizes=np.array([image.size], dtype=np.int64),
            mdv5a=letterbox(image, 1280),
            sorrel=letterbox(image, 960),
        )
        records.append(
            {
                **row,
                "dataset": dataset,
                "image": integrity(path),
                "tensor": tensor_path.name,
                "tensor_integrity": integrity(tensor_path),
            }
        )
    report = {
        "n": args.n,
        "seed": args.seed,
        "per_class_cap": args.per_class_cap,
        "animal_ids": sorted(animal_ids),
        "empty_id": args.empty_id,
        "ena_annotations": integrity(args.ena_annotations),
        "cct_annotations": integrity(args.cct_annotations) if blanks < MINIMUM_ENA_BLANKS else None,
        "ena_blank_count": blanks,
        "cases": records,
        "preprocessing": (
            "EXIF-oriented RGB; PIL BILINEAR stretch RT-DETR; "
            "OpenCV INTER_LINEAR square letterbox 114 for YOLO; "
            "MDv5a auto=False for fixed ONNX"
        ),
    }
    (args.out / "dataset.json").write_text(json.dumps(report, indent=2) + "\n")
    write_list(rows, "ENA24", args.list_out)
    write_list(rows, "CCT", args.cct_list_out)
    print(f"Prepared {args.n} ENA24 images and {len(rows) - args.n} CCT blanks in {args.out}")


if __name__ == "__main__":
    main()
