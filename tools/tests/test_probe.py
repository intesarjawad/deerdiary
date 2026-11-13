import hashlib
import json
from pathlib import Path

import pytest

from export.probe_onnx import ManifestEntry, fill_entry, pinned_source


@pytest.fixture
def entry() -> ManifestEntry:
    return {
        "id": "small",
        "role": "detector",
        "url": f"https://huggingface.co/example/model/resolve/{'a' * 40}/small.onnx",
        "licence": "Apache-2.0",
        "provenance": {"url": "https://huggingface.co/example/model", "commit": "a" * 40},
    }


def test_fill_entry(tmp_path: Path, entry: ManifestEntry) -> None:
    payload = b"small model fixture\x00\xff\n"
    model = tmp_path / "small.onnx"
    model.write_bytes(payload)

    filled = fill_entry(entry, model)
    restored = json.loads(json.dumps(filled))

    assert restored["bytes"] == len(payload)
    assert restored["sha256"] == hashlib.sha256(payload).hexdigest()
    assert restored["url"] == entry["url"]
    assert restored["provenance"] == entry["provenance"]
    assert "sha256" not in entry


@pytest.mark.parametrize("revision", ["main", "v1", "abcdef0", "g" * 40])
def test_reject_unpinned_url(tmp_path: Path, entry: ManifestEntry, revision: str) -> None:
    entry["url"] = f"https://huggingface.co/example/model/resolve/{revision}/small.onnx"
    with pytest.raises(ValueError, match="40-hex commit"):
        fill_entry(entry, tmp_path / "missing.onnx")


def test_pinned_source(entry: ManifestEntry) -> None:
    assert pinned_source(entry["url"]) == ("example/model", "a" * 40, "small.onnx")


def test_reject_mismatched_provenance(tmp_path: Path, entry: ManifestEntry) -> None:
    entry["provenance"]["commit"] = "b" * 40
    with pytest.raises(ValueError, match="provenance"):
        fill_entry(entry, tmp_path / "missing.onnx")


def test_manifest_integrity_fields() -> None:
    manifest = json.loads(
        (Path(__file__).resolve().parents[2] / "models/manifest.json").read_text()
    )
    assert manifest["files"]
    for model in manifest["files"]:
        pinned_source(model["url"])
        assert model["bytes"] > 0
        assert len(model["sha256"]) == 64
        assert len(bytes.fromhex(model["sha256"])) == 32
