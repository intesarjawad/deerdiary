import hashlib
from pathlib import Path

import pytest

from golden.acquire import Asset, acquire


def test_acquisition_verifies_download_and_cached_bytes(tmp_path: Path) -> None:
    source = tmp_path / "source.jpg"
    source.write_bytes(b"upstream image bytes")
    asset: Asset = {
        "url": source.as_uri(),
        "bytes": source.stat().st_size,
        "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
    }
    cached = tmp_path / "cache/image.jpg"
    acquire(cached, asset)
    assert cached.read_bytes() == source.read_bytes()
    acquire(cached, asset)
    cached.write_bytes(b"corrupt")
    with pytest.raises(ValueError, match="checksum mismatch"):
        acquire(cached, asset)


def test_failed_download_integrity_leaves_no_partial_file(tmp_path: Path) -> None:
    source = tmp_path / "source.pt"
    source.write_bytes(b"untrusted checkpoint")
    asset: Asset = {"url": source.as_uri(), "bytes": source.stat().st_size, "sha256": "0" * 64}
    cached = tmp_path / "cache/model.pt"
    with pytest.raises(ValueError, match="checksum mismatch"):
        acquire(cached, asset)
    assert not cached.exists()
    assert not cached.with_suffix(".pt.part").exists()
