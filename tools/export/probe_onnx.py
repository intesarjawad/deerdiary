import argparse
import hashlib
import importlib
import json
import re
from collections import Counter
from pathlib import Path
from tempfile import gettempdir
from typing import NotRequired, Protocol, TypedDict

import onnx
from onnx import AttributeProto, GraphProto, TensorProto, ValueInfoProto

MANIFEST_PATH = Path(__file__).resolve().parents[2] / "models" / "manifest.json"
PINNED_URL = re.compile(r"https://huggingface\.co/([^/]+/[^/]+)/resolve/([0-9a-f]{40})/(.+)")
CPU_OPERATORS = {"NonMaxSuppression", "NonZero", "TopK"}


class Provenance(TypedDict):
    url: str
    commit: str


class TensorIO(TypedDict):
    name: str
    dtype: str
    shape: list[int | str | None]
    dynamic_axes: list[int]


class ManifestEntry(TypedDict):
    id: str
    role: str
    url: str
    licence: str
    provenance: Provenance
    bytes: NotRequired[int]
    sha256: NotRequired[str]
    inputs: NotRequired[list[TensorIO]]
    outputs: NotRequired[list[TensorIO]]


class Manifest(TypedDict):
    upstream: dict[str, str]
    files: list[ManifestEntry]


def pinned_source(url: str) -> tuple[str, str, str]:
    """Split a Hub file URL only when it pins a full commit."""
    match = PINNED_URL.fullmatch(url)
    if match is None:
        raise ValueError(f"Expected a Hugging Face URL pinned to a 40-hex commit: {url}")
    return match[1], match[2], match[3]


def fill_entry(entry: ManifestEntry, path: Path) -> ManifestEntry:
    """Return file integrity metadata without changing the source entry."""
    repo, commit, _ = pinned_source(entry["url"])
    if entry["provenance"] != {
        "url": f"https://huggingface.co/{repo}",
        "commit": commit,
    }:
        raise ValueError(f"URL and provenance disagree: {entry['id']}")
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            size += len(chunk)
            digest.update(chunk)
    return {**entry, "bytes": size, "sha256": digest.hexdigest()}


def tensor_io(value: "ValueInfoProto") -> TensorIO:
    tensor = value.type.tensor_type
    shape: list[int | str | None] = [
        dim.dim_param
        if dim.HasField("dim_param")
        else dim.dim_value
        if dim.HasField("dim_value")
        else None
        for dim in tensor.shape.dim
    ]
    return {
        "name": value.name,
        "dtype": TensorProto.DataType.Name(tensor.elem_type),
        "shape": shape,
        "dynamic_axes": [axis for axis, dim in enumerate(shape) if not isinstance(dim, int)],
    }


def operators(graph: "GraphProto") -> Counter[str]:
    counts: Counter[str] = Counter()
    for node in graph.node:
        counts[f"{node.domain}::{node.op_type}" if node.domain else node.op_type] += 1
        for attribute in node.attribute:
            if attribute.type == AttributeProto.GRAPH:
                counts.update(operators(attribute.g))
            elif attribute.type == AttributeProto.GRAPHS:
                for nested in attribute.graphs:
                    counts.update(operators(nested))
    return counts


def probe(entry: ManifestEntry, path: Path) -> ManifestEntry:
    model = onnx.load_model_from_string(path.read_bytes())
    entry = {
        **entry,
        "inputs": [tensor_io(value) for value in model.graph.input],
        "outputs": [tensor_io(value) for value in model.graph.output],
    }
    counts = operators(model.graph)
    print(
        json.dumps(
            {
                "id": entry["id"],
                "opsets": {op.domain or "ai.onnx": op.version for op in model.opset_import},
                "inputs": entry["inputs"],
                "outputs": entry["outputs"],
                "op_histogram": dict(sorted(counts.items())),
                "webgpu_missing_ops": {
                    op: counts[op] for op in sorted(CPU_OPERATORS) if counts[op]
                },
            },
            indent=2,
        ),
        flush=True,
    )
    return entry


class DownloadFile(Protocol):
    def __call__(self, *, repo_id: str, filename: str, revision: str, cache_dir: Path) -> str: ...


def main() -> None:
    hf_hub_download: DownloadFile = importlib.import_module("huggingface_hub").hf_hub_download

    parser = argparse.ArgumentParser(
        description="Probe commit-pinned model files and their hashes."
    )
    parser.add_argument("--fill-manifest", action="store_true")
    parser.add_argument("--cache-dir", type=Path, default=Path(gettempdir()) / "deerdiary-models")
    args = parser.parse_args()
    manifest: Manifest = json.loads(MANIFEST_PATH.read_text())
    filled: list[ManifestEntry] = []
    for source_entry in manifest["files"]:
        repo, revision, filename = pinned_source(source_entry["url"])
        path = Path(
            hf_hub_download(
                repo_id=repo, filename=filename, revision=revision, cache_dir=args.cache_dir
            )
        )
        entry = fill_entry(source_entry, path)
        if filename.endswith(".onnx"):
            entry = probe(entry, path)
        else:
            print(json.dumps(entry, indent=2), flush=True)
        filled.append(entry)
    if args.fill_manifest:
        manifest["files"] = filled
        MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
