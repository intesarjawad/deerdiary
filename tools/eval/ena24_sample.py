"""Reserve an auditable detector holdout, then acquire disjoint ENA24 evaluation images."""

import argparse
import hashlib
import json
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import NotRequired, TypedDict

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eval.prepare_selection import sample

ROOT = Path(__file__).resolve().parents[2]
METADATA_URL = "https://storage.googleapis.com/public-datasets-lila/ena24/ena24.json"
BASE_URL = "https://lilawildlife.blob.core.windows.net/lila-wildlife"
SEED = 20261104
HOLDOUT_SIZE = 1000


class ImageRecord(TypedDict):
    id: str
    file_name: str
    width: int
    height: int
    location: NotRequired[str]
    location_id: NotRequired[str]
    camera_id: NotRequired[str]


class Annotation(TypedDict):
    image_id: str
    category_id: int
    bbox: list[float]


class Category(TypedDict):
    id: int
    name: str


class Metadata(TypedDict):
    images: list[ImageRecord]
    annotations: list[Annotation]
    categories: list[Category]


class Availability(TypedDict):
    files: dict[str, int]
    listing_bytes_downloaded: int


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def public_files(cache: Path) -> Availability:
    if cache.exists():
        return json.loads(cache.read_text())
    files: dict[str, int] = {}
    marker = ""
    transferred = 0
    while True:
        query = urllib.parse.urlencode(
            {
                "restype": "container",
                "comp": "list",
                "prefix": "ena24/images/",
                "maxresults": 5000,
                "marker": marker,
            }
        )
        with urllib.request.urlopen(f"{BASE_URL}?{query}", timeout=60) as response:
            data = response.read()
        transferred += len(data)
        listing = ET.fromstring(data)
        for blob in listing.findall("./Blobs/Blob"):
            name = blob.findtext("Name", "")
            size = blob.findtext("./Properties/Content-Length", "")
            if name.lower().endswith(".jpg"):
                files[name.removeprefix("ena24/images/")] = int(size)
        marker = listing.findtext("NextMarker", "")
        if not marker:
            break
    result: Availability = {"files": files, "listing_bytes_downloaded": transferred}
    cache.write_text(json.dumps(result, indent=2) + "\n")
    return result


def candidates(metadata: Metadata, available: dict[str, int]) -> list[dict[str, object]]:
    labels: dict[str, set[int]] = defaultdict(set)
    for annotation in metadata["annotations"]:
        labels[annotation["image_id"]].add(annotation["category_id"])
    return [
        {"path": image["file_name"], "stratum": str(min(labels[image["id"]]))}
        for image in metadata["images"]
        if image["file_name"] in available and labels[image["id"]]
    ]


def read_list(path: Path) -> set[str]:
    paths = [line.split()[-1] for line in path.read_text().splitlines() if line.strip()]
    if not paths or len(paths) != len(set(paths)):
        raise ValueError(f"Exclusion list must be nonempty and unique: {path}")
    return set(paths)


def acquire_images(
    metadata: Metadata, available: Availability, names: set[str], data_dir: Path
) -> tuple[list[dict[str, object]], int]:
    data_dir.mkdir(parents=True, exist_ok=True)
    annotations: dict[str, list[Annotation]] = defaultdict(list)
    for annotation in metadata["annotations"]:
        annotations[annotation["image_id"]].append(annotation)
    records: list[dict[str, object]] = []
    downloaded = 0
    selected = sorted(
        (image for image in metadata["images"] if image["file_name"] in names),
        key=lambda image: image["file_name"],
    )

    def acquire(image: ImageRecord) -> tuple[dict[str, object], int]:
        name = image["file_name"]
        transferred = 0
        destination = (data_dir / name).resolve()
        if not destination.is_relative_to(data_dir.resolve()):
            raise ValueError(f"Unsafe ENA24 path: {name}")
        size = available["files"][name]
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.exists():
            temporary = destination.with_suffix(".part")
            with (
                urllib.request.urlopen(f"{BASE_URL}/ena24/images/{name}", timeout=60) as response,
                temporary.open("wb") as stream,
            ):
                while chunk := response.read(64 * 1024):
                    transferred += len(chunk)
                    stream.write(chunk)
            if temporary.stat().st_size != size:
                raise ValueError(f"Download size mismatch: {name}")
            temporary.replace(destination)
        if destination.stat().st_size != size:
            raise ValueError(f"Cached image size mismatch: {name}")
        return {
            **image,
            "sha256": digest(destination),
            "bytes": size,
            "annotations": annotations[image["id"]],
        }, transferred

    with ThreadPoolExecutor(max_workers=4) as executor:
        for record, transferred in executor.map(acquire, selected):
            records.append(record)
            downloaded += transferred
            if len(records) % 100 == 0:
                print(
                    f"Verified {len(records)}/{len(names)}; downloaded {downloaded} image bytes",
                    flush=True,
                )
    return records, downloaded


def validate_existing(data_dir: Path, output: Path, names: set[str]) -> dict[str, str]:
    if data_dir.exists():
        present = {
            path.relative_to(data_dir).as_posix()
            for path in data_dir.rglob("*")
            if path.suffix.lower() in {".jpg", ".jpeg"}
        }
        if present - names:
            raise ValueError(
                "Data directory contains unselected images; choose a dedicated directory"
            )
    expected_checksums = {}
    if output.exists():
        expected_checksums = dict(
            line.split(maxsplit=1)[::-1] for line in output.read_text().splitlines()
        )
        expected_checksums = {name.strip(): sha for name, sha in expected_checksums.items()}
        if expected_checksums.keys() != names:
            raise ValueError(
                "Existing evaluation list selects different images; choose a new output"
            )
    return expected_checksums


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--n", type=int, default=2000)
    parser.add_argument("--seed", type=int, default=SEED)
    parser.add_argument("--per-class-cap", type=int, default=2000)
    parser.add_argument("--metadata", type=Path, default=ROOT / ".cache/ena24.json")
    parser.add_argument("--availability", type=Path, default=ROOT / ".cache/ena24-available.json")
    parser.add_argument("--exclude", type=Path, required=True)
    parser.add_argument(
        "--reserve-substitute",
        action="store_true",
        help="Create the ADR 0013 holdout; does not download its images",
    )
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "tools/eval/data/eval_2000")
    parser.add_argument("--manifest", type=Path, default=ROOT / "tools/eval/results/dataset.json")
    parser.add_argument("--max-image-bytes", type=int, default=1_250_000_000)
    args = parser.parse_args()
    if args.n <= 0 or args.per_class_cap <= 0:
        parser.error("n and per-class-cap must be positive")
    args.metadata.parent.mkdir(parents=True, exist_ok=True)
    if not args.metadata.exists():
        urllib.request.urlretrieve(METADATA_URL, args.metadata)
    metadata: Metadata = json.loads(args.metadata.read_text())
    available = public_files(args.availability)
    rows = candidates(metadata, available["files"])
    if args.reserve_substitute:
        if args.exclude.exists():
            raise ValueError("Refusing to overwrite an existing holdout")
        reserved = sample(rows, HOLDOUT_SIZE, HOLDOUT_SIZE, args.seed)
        args.exclude.parent.mkdir(parents=True, exist_ok=True)
        args.exclude.write_text("".join(f"{row['path']}\n" for row in reserved))
    excluded = read_list(args.exclude)
    if len(excluded) != HOLDOUT_SIZE:
        raise ValueError("Expected exactly 1,000 reserved detector-selection paths")
    selected = sample(
        [row for row in rows if row["path"] not in excluded], args.n, args.per_class_cap, args.seed
    )
    names = {str(row["path"]) for row in selected}
    expected_checksums = validate_existing(args.data_dir, args.out, names)
    expected_bytes = sum(available["files"][name] for name in names)
    if expected_bytes > args.max_image_bytes:
        raise ValueError(
            f"Selected images need {expected_bytes} bytes; budget {args.max_image_bytes}"
        )
    records, downloaded = acquire_images(metadata, available, names, args.data_dir)
    if expected_checksums and any(
        expected_checksums[str(row["file_name"])] != row["sha256"] for row in records
    ):
        raise ValueError("Downloaded or cached image differs from the committed checksum")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text("".join(f"{row['sha256']}  {row['file_name']}\n" for row in records))
    manifest = {
        "seed": args.seed,
        "n": args.n,
        "per_class_cap": args.per_class_cap,
        "metadata_url": METADATA_URL,
        "metadata_sha256": digest(args.metadata),
        "image_base_url": f"{BASE_URL}/ena24/images/",
        "image_bytes": expected_bytes,
        "listing_bytes_downloaded": available["listing_bytes_downloaded"],
        "exclusion_sha256": digest(args.exclude),
        "excluded_count": len(excluded),
        "exclusion_rule": "ADR 0013 substitute detector holdout",
        "resampling_unit": "location"
        if any(
            any(key in image for key in ("location", "location_id", "camera_id"))
            for image in metadata["images"]
        )
        else "image",
        "categories": metadata["categories"],
        "images": records,
    }
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(json.dumps(manifest, indent=2) + "\n")
    print(
        f"Acquired {len(records)} disjoint images ({expected_bytes} bytes); {downloaded} new bytes"
    )


if __name__ == "__main__":
    main()
