"""Build the instant sample and the benchmark card from one Caltech Camera Traps location.

Run from tools/: `uv run python -m sample.make_demo_card`.

The location is chosen for what a first diary needs, not for size: the number of species with
at least five independent detections, then the share of photos taken at night. From it, whole
camera bursts are taken, spread across the months the camera ran, until the sample holds 60
photos: a fifth of them empty frames, the rest a rotation through the qualifying species.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import shutil
import tempfile
import zipfile
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import NotRequired, TypedDict
from urllib.request import urlopen

from sample.make_sample import (
    JPEG_QUALITY,
    LONG_SIDE_PX,
    SAMPLE_PHOTO_COUNT,
    sample_problems,
    write_sample_photo,
)

ROOT = Path(__file__).resolve().parents[2]
DATASET_PAGE = "https://lila.science/datasets/caltech-camera-traps"
METADATA_URL = (
    "https://storage.googleapis.com/public-datasets-lila/caltechcameratraps/labels/"
    "caltech_camera_traps.json.zip"
)
METADATA_FILE = "caltech_images_20210113.json"
IMAGE_BASE_URL = "https://storage.googleapis.com/public-datasets-lila/caltech-unzipped/cct_images/"
LICENCE = "Community Data License Agreement (permissive variant)"
LICENCE_URL = "https://cdla.io/permissive-1-0/"
CITATION = (
    "Sara Beery, Grant Van Horn, Pietro Perona. Recognition in Terra Incognita. "
    "Proceedings of the 15th European Conference on Computer Vision (ECCV 2018)."
)
DATE_FORMAT = "%Y-%m-%d %H:%M:%S"
# The app's default independence interval (src/core/independence.ts).
INDEPENDENCE_INTERVAL = timedelta(minutes=30)
MIN_INDEPENDENT_DETECTIONS = 5
NIGHT_START_HOUR = 20
NIGHT_END_HOUR = 6
# Real cards are mostly empty frames; a fifth shows the empty-frame handling without filler.
EMPTY_PHOTOS = 12
EMPTY = "empty"
# Caltech Camera Traps labels vehicles as "car" and has no person category.
EXCLUDED_LABELS = frozenset({"car"})
RANKING_ROWS = 10
DOWNLOAD_TIMEOUT_S = 120


@dataclass(frozen=True)
class Photo:
    image_id: str
    file_name: str
    location: str
    sequence_id: str
    frame: int
    burst_size: int
    captured: datetime
    labels: frozenset[str]
    rights_holder: str


@dataclass(frozen=True)
class LocationRank:
    location: str
    photo_count: int
    night_share: float
    independent: dict[str, int]

    @property
    def qualifying_species(self) -> list[str]:
        """Species with enough independent detections, most detected first."""
        return sorted(
            (name for name, n in self.independent.items() if n >= MIN_INDEPENDENT_DETECTIONS),
            key=lambda name: (-self.independent[name], name),
        )


Burst = tuple[Photo, ...]


def is_night(moment: datetime) -> bool:
    return moment.hour >= NIGHT_START_HOUR or moment.hour < NIGHT_END_HOUR


def species_labels(labels: Iterable[str]) -> set[str]:
    return set(labels) - {EMPTY} - EXCLUDED_LABELS


class CctImage(TypedDict):
    id: str
    file_name: str
    location: str | int
    seq_id: str
    frame_num: NotRequired[int]
    seq_num_frames: NotRequired[int]
    date_captured: str
    rights_holder: NotRequired[str]


class CctAnnotation(TypedDict):
    image_id: str
    category_id: int


class CctCategory(TypedDict):
    id: int
    name: str


class CctMetadata(TypedDict):
    images: list[CctImage]
    annotations: list[CctAnnotation]
    categories: list[CctCategory]


REQUIRED_IMAGE_FIELDS = ("id", "file_name", "location", "seq_id", "date_captured")


def parse_photos(metadata: CctMetadata) -> tuple[list[Photo], int]:
    """Photos with a readable capture time, and how many were skipped for lacking one."""
    for index, image in enumerate(metadata["images"]):
        missing = [field for field in REQUIRED_IMAGE_FIELDS if field not in image]
        if missing:
            raise ValueError(f"images[{index}] lacks {', '.join(missing)}; the format changed")
    names = {category["id"]: category["name"] for category in metadata["categories"]}
    labels: dict[str, set[str]] = defaultdict(set)
    for annotation in metadata["annotations"]:
        labels[annotation["image_id"]].add(names[annotation["category_id"]])
    photos: list[Photo] = []
    skipped = 0
    for image in metadata["images"]:
        try:
            captured = datetime.strptime(image["date_captured"], DATE_FORMAT)
        except ValueError:
            skipped += 1
            continue
        photos.append(
            Photo(
                image_id=image["id"],
                file_name=image["file_name"],
                location=str(image["location"]),
                sequence_id=image["seq_id"],
                frame=image.get("frame_num", 0),
                burst_size=image.get("seq_num_frames", 1),
                captured=captured,
                labels=frozenset(labels[image["id"]]),
                rights_holder=image.get("rights_holder", ""),
            )
        )
    return photos, skipped


def independent_detections(photos: Iterable[Photo]) -> dict[str, list[Photo]]:
    """Per species, the photos that open an independent detection at one camera."""
    last_counted: dict[tuple[str, str], datetime] = {}
    counted: dict[str, list[Photo]] = defaultdict(list)
    for photo in sorted(photos, key=lambda p: (p.captured, p.frame, p.image_id)):
        for name in sorted(species_labels(photo.labels)):
            previous = last_counted.get((photo.location, name))
            if previous is None or photo.captured - previous > INDEPENDENCE_INTERVAL:
                counted[name].append(photo)
                last_counted[(photo.location, name)] = photo.captured
    return dict(counted)


def rank_locations(photos: Iterable[Photo]) -> list[LocationRank]:
    by_location: dict[str, list[Photo]] = defaultdict(list)
    for photo in photos:
        by_location[photo.location].append(photo)
    ranks = [
        LocationRank(
            location=location,
            photo_count=len(group),
            night_share=sum(is_night(p.captured) for p in group) / len(group),
            independent={name: len(hits) for name, hits in independent_detections(group).items()},
        )
        for location, group in by_location.items()
    ]
    return sorted(ranks, key=lambda r: (-len(r.qualifying_species), -r.night_share, r.location))


def spread_order(count: int) -> list[int]:
    """Indices 0..count-1 in van der Corput order: middle, quarters, eighths, and so on."""
    order: list[int] = []
    seen: set[int] = set()
    step = 1
    while len(order) < count:
        fraction, denominator, n = 0.0, 1, step
        while n:
            denominator *= 2
            fraction += (n % 2) / denominator
            n //= 2
        index = int(fraction * count)
        if index not in seen:
            seen.add(index)
            order.append(index)
        step += 1
    return order


def bursts(photos: Iterable[Photo]) -> list[Burst]:
    grouped: dict[str, list[Photo]] = defaultdict(list)
    for photo in photos:
        grouped[photo.sequence_id].append(photo)
    return sorted(
        (tuple(sorted(group, key=lambda p: (p.frame, p.captured))) for group in grouped.values()),
        key=lambda burst: (burst[0].captured, burst[0].sequence_id),
    )


def burst_labels(burst: Burst) -> set[str]:
    return {label for photo in burst for label in photo.labels}


def select_bursts(location_photos: Sequence[Photo], rank: LocationRank) -> list[Burst]:
    """Complete bursts: empty ones up to EMPTY_PHOTOS, then each species in turn until full."""
    opening = {
        photo.image_id
        for hits in independent_detections(location_photos).values()
        for photo in hits
    }
    # The dataset dropped some frames of bursts, and a frame left behind can still show the
    # person who was in the dropped ones while being labelled empty.
    usable = [
        b
        for b in bursts(location_photos)
        if len(b) == b[0].burst_size and not burst_labels(b) & EXCLUDED_LABELS
    ]
    empties = [b for b in usable if burst_labels(b) == {EMPTY}]
    by_species: dict[str, list[Burst]] = {
        name: [
            b
            for b in usable
            if species_labels(burst_labels(b)) == {name}
            and any(photo.image_id in opening for photo in b)
        ]
        for name in rank.qualifying_species
    }

    chosen: list[Burst] = []
    used = 0
    for index in spread_order(len(empties)):
        if used + len(empties[index]) <= EMPTY_PHOTOS:
            chosen.append(empties[index])
            used += len(empties[index])
    queues = {
        name: [candidates[i] for i in spread_order(len(candidates))]
        for name, candidates in by_species.items()
    }
    added = True
    while added:
        added = False
        for name in rank.qualifying_species:
            queue = queues[name]
            while queue:
                burst = queue.pop(0)
                if used + len(burst) <= SAMPLE_PHOTO_COUNT:
                    chosen.append(burst)
                    used += len(burst)
                    added = True
                    break
    return sorted(chosen, key=lambda burst: burst[0].captured)


def verify_licence() -> date:
    """Reads the dataset page and fails unless it still states the licence the sample relies on."""
    with urlopen(DATASET_PAGE, timeout=DOWNLOAD_TIMEOUT_S) as response:
        page = response.read().decode("utf-8")
    text = " ".join(html.unescape(re.sub(r"<[^>]+>", " ", page)).split())
    if f"released under the {LICENCE}" not in text:
        raise SystemExit(f"{DATASET_PAGE} no longer states the {LICENCE}; stop and review it")
    return datetime.now(UTC).date()


def download(url: str, target: Path) -> None:
    if target.exists():
        return
    partial = target.with_suffix(target.suffix + ".part")
    try:
        with urlopen(url, timeout=DOWNLOAD_TIMEOUT_S) as response, partial.open("wb") as stream:
            shutil.copyfileobj(response, stream)
        partial.replace(target)
    finally:
        partial.unlink(missing_ok=True)


def load_metadata(downloads: Path) -> CctMetadata:
    archive = downloads / "caltech_camera_traps.json.zip"
    download(METADATA_URL, archive)
    with zipfile.ZipFile(archive) as bundle, bundle.open(METADATA_FILE) as stream:
        metadata: CctMetadata = json.load(stream)
    return metadata


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def provenance(
    *,
    read_on: date,
    ranks: Sequence[LocationRank],
    chosen: Sequence[Burst],
    skipped: int,
    digests: dict[str, str],
) -> str:
    top = ranks[0]
    photos = [photo for burst in chosen for photo in burst]
    night = sum(is_night(photo.captured) for photo in photos)
    holders = sorted({photo.rights_holder for photo in photos})
    lines = [
        "Sample photos: Caltech Camera Traps, distributed by LILA BC",
        "",
        f"Dataset page: {DATASET_PAGE} (read {read_on.isoformat()})",
        f"Licence: {LICENCE}, {LICENCE_URL}",
        f"Citation: {CITATION}",
        f"Rights holder: {', '.join(holders)}",
        f"Metadata: {METADATA_FILE} from {METADATA_URL}",
        f"Images: {IMAGE_BASE_URL}<file>",
        "",
        "Location",
        f"Locations ranked by the number of species with at least {MIN_INDEPENDENT_DETECTIONS}"
        f" independent detections ({int(INDEPENDENCE_INTERVAL.total_seconds() // 60)}-minute"
        f" rule, per species), then by the share of photos taken between"
        f" {NIGHT_START_HOUR:02d}:00 and {NIGHT_END_HOUR:02d}:00. Labels {EMPTY!r} and"
        f" {', '.join(sorted(EXCLUDED_LABELS))!r} are not species. {skipped} photo(s) without a"
        " readable capture time were left out.",
        "",
        "rank  location  species  night share  photos",
        *(
            f"{position:>4}  {rank.location:>8}  {len(rank.qualifying_species):>7}"
            f"  {rank.night_share:>11.3f}  {rank.photo_count:>6}"
            for position, rank in enumerate(ranks[:RANKING_ROWS], start=1)
        ),
        "",
        f"Chosen: location {top.location}, first in the ranking, with"
        f" {len(top.qualifying_species)} species: "
        + ", ".join(f"{name} {top.independent[name]}" for name in top.qualifying_species)
        + " independent detections.",
        "",
        "Selection",
        f"Whole camera bursts, spread over the location's dates in van der Corput order: empty"
        f" bursts up to {EMPTY_PHOTOS} photos, then one burst per species in turn, most detected"
        f" species first, until {SAMPLE_PHOTO_COUNT} photos. Each species burst opens an"
        " independent detection and carries that one species label. Bursts labelled"
        f" {', '.join(sorted(EXCLUDED_LABELS))!r} are excluded, and so are bursts missing frames:"
        " the dataset removed frames from some bursts, and one kept frame labelled empty showed"
        f" a person. {len(photos)} photos,"
        f" {night} taken at night.",
        "",
        "Changes",
        f"Downsized to {LONG_SIDE_PX} px on the long side and saved at JPEG quality"
        f" {JPEG_QUALITY}. All metadata is removed except EXIF DateTimeOriginal, which holds"
        " the dataset's date_captured. File names are the dataset's.",
        "",
        "file  sequence  frame  captured  dataset label  original sha256",
        *(
            f"{photo.file_name}  {photo.sequence_id}  {photo.frame}"
            f"  {photo.captured.strftime(DATE_FORMAT)}  {'+'.join(sorted(photo.labels))}"
            f"  {digests[photo.file_name]}"
            for photo in photos
        ),
    ]
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "public/sample")
    parser.add_argument("--card", type=Path, default=ROOT / "tools/bench/data/card")
    parser.add_argument(
        "--downloads",
        type=Path,
        help="keep downloads here between runs (default: a temporary folder, removed after)",
    )
    args = parser.parse_args()

    read_on = verify_licence()
    downloads = args.downloads or Path(tempfile.mkdtemp(prefix="deerdiary-cct-"))
    downloads.mkdir(parents=True, exist_ok=True)
    try:
        photos, skipped = parse_photos(load_metadata(downloads))
        ranks = rank_locations(photos)
        for position, rank in enumerate(ranks[:RANKING_ROWS], start=1):
            print(
                f"{position:>2}. location {rank.location}: {len(rank.qualifying_species)}"
                f" species, night share {rank.night_share:.3f}, {rank.photo_count} photos"
            )
        top = ranks[0]
        chosen = select_bursts([p for p in photos if p.location == top.location], top)

        for stale in args.output.glob("*.jpg"):
            stale.unlink()
        args.card.mkdir(parents=True, exist_ok=True)
        digests: dict[str, str] = {}
        for photo in (photo for burst in chosen for photo in burst):
            original = downloads / photo.file_name
            download(IMAGE_BASE_URL + photo.file_name, original)
            digests[photo.file_name] = sha256(original)
            shutil.copyfile(original, args.card / photo.file_name)
            write_sample_photo(original, args.output / photo.file_name, photo.captured)
        (args.output / "PROVENANCE.txt").write_text(
            provenance(
                read_on=read_on, ranks=ranks, chosen=chosen, skipped=skipped, digests=digests
            ),
            encoding="utf-8",
        )
    finally:
        if args.downloads is None:
            shutil.rmtree(downloads, ignore_errors=True)
    problems = sample_problems(args.output)
    if problems:
        raise SystemExit("\n".join(problems))
    print(f"Wrote {SAMPLE_PHOTO_COUNT} photos from location {top.location} to {args.output}")


if __name__ == "__main__":
    main()
