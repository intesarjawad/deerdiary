"""Keep full inference evidence in checksum-verified, small gzip shards."""

import argparse
import gzip
import hashlib
import json
import sys
from pathlib import Path
from typing import NotRequired, TypedDict

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eval.agreement import Detection

IMAGES_PER_SHARD = 100


class Prediction(TypedDict):
    filepath: str
    detections: list[Detection]
    country: NotRequired[str]
    failures: NotRequired[list[str]]


class Shard(TypedDict):
    file: str
    sha256: str
    images: int
    bytes: int


class Document(TypedDict):
    predictions: NotRequired[list[Prediction]]
    shards: NotRequired[list[Shard]]


def read_predictions(path: Path) -> list[Prediction]:
    document: Document = json.loads(path.read_text())
    if "predictions" in document:
        return document["predictions"]
    if "shards" not in document or not document["shards"]:
        raise ValueError(f"Missing predictions or shards: {path}")
    predictions: list[Prediction] = []
    for shard in document["shards"]:
        source = (path.parent / shard["file"]).resolve()
        if not source.is_relative_to(path.parent.resolve()):
            raise ValueError(f"Prediction shard escapes results directory: {source}")
        data = source.read_bytes()
        if hashlib.sha256(data).hexdigest() != shard["sha256"]:
            raise ValueError(f"Prediction shard checksum mismatch: {source}")
        batch: Document = json.loads(gzip.decompress(data))
        if "predictions" not in batch or len(batch["predictions"]) != shard["images"]:
            raise ValueError(f"Prediction shard image count mismatch: {source}")
        predictions.extend(batch["predictions"])
    return predictions


def pack(path: Path) -> None:
    raw = path.read_bytes()
    document: Document = json.loads(raw)
    if "predictions" not in document or not document["predictions"]:
        raise ValueError(f"Expected a nonempty, unpacked SpeciesNet export: {path}")
    predictions = document["predictions"]
    directory = path.with_suffix("")
    directory.mkdir(exist_ok=True)
    shards: list[Shard] = []
    for offset in range(0, len(predictions), IMAGES_PER_SHARD):
        selected = predictions[offset : offset + IMAGES_PER_SHARD]
        batch = {**document, "predictions": selected}
        payload = json.dumps(batch, separators=(",", ":")).encode()
        compressed = gzip.compress(payload, mtime=0)
        if json.loads(gzip.decompress(compressed)) != batch:
            raise ValueError("Prediction shard changed JSON values")
        destination = directory / f"{offset // IMAGES_PER_SHARD + 1:03}.json.gz"
        destination.write_bytes(compressed)
        shards.append(
            {
                "file": destination.relative_to(path.parent).as_posix(),
                "sha256": hashlib.sha256(compressed).hexdigest(),
                "images": len(selected),
                "bytes": len(compressed),
            }
        )
    index = {
        "format": "speciesnet-json-shards-v1",
        "images": len(predictions),
        "source_json_sha256": hashlib.sha256(raw).hexdigest(),
        "metadata": {key: value for key, value in document.items() if key != "predictions"},
        "shards": shards,
    }
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(index, indent=2) + "\n")
    temporary.replace(path)
    print(f"Packed {len(predictions)} predictions into {len(shards)} lossless gzip shards")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("export", type=Path)
    pack(parser.parse_args().export)


if __name__ == "__main__":
    main()
