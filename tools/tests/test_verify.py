import json
from pathlib import Path

import onnx
import pytest

from export import verify


@pytest.fixture
def export_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path, Path]:
    exported = tmp_path / "exported"
    exported.mkdir()
    source = tmp_path / "source"
    source.mkdir()
    info = {
        "version": "4.0.3a",
        "type": "always_crop",
        "classifier": "classifier.pt",
        "classifier_labels": "labels.txt",
        "taxonomy": "taxonomy.txt",
        "geofence": "geofence.json",
        "detector": "detector.pt",
    }
    for name in ("labels.txt", "taxonomy.txt", "geofence.json"):
        (source / name).write_text(name)
        (exported / name).write_text(name)
    fp32 = exported / "classifier.fp32.onnx"
    fp16 = exported / "classifier.fp16.onnx"
    for path, dtype in ((fp32, onnx.TensorProto.FLOAT), (fp16, onnx.TensorProto.FLOAT16)):
        model = onnx.helper.make_model(
            onnx.helper.make_graph(
                [onnx.helper.make_node("Identity", ["image"], ["logits"])],
                "test",
                [onnx.helper.make_tensor_value_info("image", dtype, [1, 3])],
                [onnx.helper.make_tensor_value_info("logits", dtype, [1, 3])],
            )
        )
        path.write_bytes(model.SerializeToString())
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"upstream": {"speciesnet_pypi": "5.0.6"}}))
    monkeypatch.setattr(verify, "ROOT", tmp_path)
    monkeypatch.setattr(verify, "EXPORT_DIR", exported)
    monkeypatch.setattr(verify, "MODEL_DIR", source)
    monkeypatch.setattr(verify, "MANIFEST_PATH", manifest)
    monkeypatch.setattr(verify, "read_info", lambda: info)
    return fp32, fp16, manifest


def test_manifest_preserves_measured_precision_for_unchanged_artifacts(
    export_files: tuple[Path, Path, Path],
) -> None:
    fp32, fp16, path = export_files
    verify.write_manifest(fp32, fp16)
    manifest = json.loads(path.read_text())
    policy = "fp16 only: measured WASM ratio 0.98 with identical native top-1"
    manifest["local_exports"]["precision_policy"] = policy
    manifest["local_exports"]["files"].reverse()
    path.write_text(json.dumps(manifest))

    verify.write_manifest(fp32, fp16)
    verify.write_manifest(fp32, fp16)

    restored = json.loads(path.read_text())
    assert restored["local_exports"]["precision_policy"] == policy
    assert restored["upstream"] == {"speciesnet_pypi": "5.0.6"}


@pytest.mark.parametrize("changed", ["fp32", "fp16", "labels"])
def test_manifest_invalidates_precision_when_artifacts_change(
    export_files: tuple[Path, Path, Path], changed: str
) -> None:
    fp32, fp16, path = export_files
    verify.write_manifest(fp32, fp16)
    manifest = json.loads(path.read_text())
    manifest["local_exports"]["precision_policy"] = "fp16 only: measured"
    path.write_text(json.dumps(manifest))
    if changed == "labels":
        for folder in (fp32.parent, path.parent / "source"):
            (folder / "labels.txt").write_text("updated labels")
    else:
        model_path = fp32 if changed == "fp32" else fp16
        model = onnx.load_model_from_string(model_path.read_bytes())
        model.producer_version = "updated"
        model_path.write_bytes(model.SerializeToString())

    verify.write_manifest(fp32, fp16)

    restored = json.loads(path.read_text())
    assert restored["local_exports"]["precision_policy"].startswith("pending ADR 0003")
