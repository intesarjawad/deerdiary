import json
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from sample.depth_master import cap_rows, pack16, unpack16
from sample.make_demo_card import (
    EMPTY_PHOTOS,
    CctMetadata,
    Photo,
    burst_labels,
    independent_detections,
    parse_photos,
    rank_locations,
    select_bursts,
    spread_order,
)
from sample.make_sample import (
    GPS_IFD,
    LONG_SIDE_PX,
    SAMPLE_PHOTO_COUNT,
    photo_problems,
    write_sample_photo,
)

START = datetime(2011, 7, 1, 22, 0, 0)
CAMERA_MODEL = 0x0110


def burst(
    sequence: str, labels: set[str], at: datetime, location: str = "46", frames: int = 3
) -> list[Photo]:
    return [
        Photo(
            image_id=f"{sequence}-{frame}",
            file_name=f"{sequence}-{frame}.jpg",
            location=location,
            sequence_id=sequence,
            frame=frame,
            burst_size=3,
            captured=at + timedelta(seconds=frame),
            labels=frozenset(labels),
            rights_holder="Justin Brown",
        )
        for frame in range(1, frames + 1)
    ]


def test_independence_counts_a_species_again_only_after_thirty_minutes() -> None:
    photos = [
        *burst("a", {"bobcat"}, START),
        *burst("b", {"bobcat"}, START + timedelta(minutes=29)),
        *burst("c", {"bobcat"}, START + timedelta(minutes=31)),
        *burst("d", {"bobcat"}, START + timedelta(minutes=29), location="47"),
        *burst("e", {"empty"}, START),
        *burst("f", {"car"}, START),
    ]
    counted = independent_detections(photos)
    assert set(counted) == {"bobcat"}
    assert [p.image_id for p in counted["bobcat"]] == ["a-1", "d-1", "c-1"]


def test_locations_rank_by_qualifying_species_then_night_share() -> None:
    def location(name: str, species: list[str], hour: int) -> list[Photo]:
        return [
            photo
            for index, label in enumerate(species)
            for day in range(5)
            for photo in burst(
                f"{name}-{index}-{day}", {label}, datetime(2012, 1, 1 + day, hour), name
            )
        ]

    photos = [
        *location("day", ["deer", "fox"], 12),
        *location("night", ["deer", "fox"], 23),
        *location("one", ["deer"], 23),
        *burst("rare", {"badger"}, START, "one"),
    ]
    ranks = rank_locations(photos)
    assert [r.location for r in ranks] == ["night", "day", "one"]
    assert ranks[2].qualifying_species == ["deer"]
    assert ranks[0].night_share == 1.0


def test_spread_order_visits_every_index_once_starting_in_the_middle() -> None:
    assert spread_order(4) == [2, 1, 3, 0]
    assert sorted(spread_order(7)) == list(range(7))
    assert spread_order(0) == []


def test_selection_fills_the_sample_with_complete_bursts_and_no_vehicles() -> None:
    photos: list[Photo] = []
    for day in range(40):
        at = START + timedelta(days=day)
        photos += burst(f"empty-{day}", {"empty"}, at)
        photos += burst(f"bobcat-{day}", {"bobcat"}, at + timedelta(hours=1))
        photos += burst(f"rabbit-{day}", {"rabbit"}, at + timedelta(hours=2))
        photos += burst(f"car-{day}", {"car", "rabbit"}, at + timedelta(hours=3))
        photos += burst(f"partial-{day}", {"empty"}, at + timedelta(hours=4), frames=2)
    [rank] = rank_locations(photos)
    chosen = select_bursts(photos, rank)
    labels = [burst_labels(b) for b in chosen]
    assert sum(len(b) for b in chosen) == SAMPLE_PHOTO_COUNT
    assert all(len({p.sequence_id for p in b}) == 1 and len(b) == 3 for b in chosen)
    assert all("car" not in label for label in labels)
    assert sum(len(b) for b, label in zip(chosen, labels, strict=True) if label == {"empty"}) == (
        EMPTY_PHOTOS
    )
    assert {"bobcat"} in labels
    assert {"rabbit"} in labels
    assert [b[0].captured for b in chosen] == sorted(b[0].captured for b in chosen)


def test_metadata_without_a_location_is_rejected() -> None:
    metadata: CctMetadata = json.loads(
        '{"categories": [{"id": 6, "name": "bobcat"}],'
        ' "annotations": [{"image_id": "x", "category_id": 6}],'
        ' "images": [{"id": "x", "file_name": "x.jpg", "seq_id": "s",'
        ' "date_captured": "2012-01-01 00:00:00"}]}'
    )
    with pytest.raises(ValueError, match=r"images\[0\] lacks location"):
        parse_photos(metadata)


def test_sample_photo_keeps_only_its_capture_time(tmp_path: Path) -> None:
    source = tmp_path / "original.jpg"
    exif = Image.Exif()
    exif[GPS_IFD] = {1: "N", 2: (34.0, 8.0, 0.0)}
    exif[CAMERA_MODEL] = "Trail camera"
    Image.new("RGB", (2048, 1494), "gray").save(source, exif=exif)
    assert photo_problems(source) == [
        "original.jpg has GPS tags",
        "original.jpg has no EXIF capture time",
        f"original.jpg keeps camera tags [{CAMERA_MODEL}]",
        f"original.jpg is 2048 px on its long side, over {LONG_SIDE_PX}",
    ]

    target = tmp_path / "sample.jpg"
    write_sample_photo(source, target, datetime(2011, 7, 1, 22, 10, 5))
    assert photo_problems(target) == []
    assert b"2011:07:01 22:10:05\x00" in target.read_bytes()
    with Image.open(target) as image:
        assert image.size == (LONG_SIDE_PX, 1167)


def test_depth_survives_the_16_bit_png_packing() -> None:
    values = np.linspace(0, 1, 513, dtype=np.float32).reshape(27, 19)
    restored = unpack16(pack16(values))
    assert float(np.max(np.abs(restored - values))) <= 0.5 / 65535 + 1e-7
    top = pack16(np.ones((1, 1), dtype=np.float32))
    assert (int(top[0, 0, 0]), int(top[0, 0, 1]), int(top[0, 0, 2])) == (255, 255, 0)


def test_a_near_branch_is_laid_level_with_its_row() -> None:
    ground = np.tile(np.linspace(0.1, 0.9, 8, dtype=np.float32)[:, None], (1, 20))
    ground[1, 18:] = 1.0
    capped = cap_rows(ground)
    assert float(capped[1].max()) == float(ground[1, 0])
    assert np.array_equal(capped[2:], ground[2:])
