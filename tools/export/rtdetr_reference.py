import importlib
import json
import shutil
import sys
from collections.abc import Callable
from importlib.metadata import distribution
from pathlib import Path
from typing import Protocol, Required, TypedDict

import numpy as np
import torch
from numpy.typing import NDArray
from PIL import Image, ImageFile, ImageOps

from export.rtdetr_source import (
    CHECKPOINT,
    CHECKPOINT_INTEGRITY,
    CHECKPOINT_URL,
    EXPORT_DIR,
    IMAGE_COUNT,
    IMAGE_SIZE,
    OPSET,
    REFERENCE_DIR,
    SEED,
    Reference,
    model_path,
    require_disk_space,
)
from export.speciesnet_source import ROOT, integrity
from golden.acquire import Provenance, acquire


class Deployable(Protocol):
    def deploy(self) -> torch.nn.Module: ...
    def load_state_dict(self, state: dict[str, torch.Tensor], *, strict: bool) -> object: ...


class Configuration(Protocol):
    model: Deployable
    postprocessor: Deployable


class Ema(TypedDict):
    module: dict[str, torch.Tensor]


class Checkpoint(TypedDict, total=False):
    ema: Ema
    model: Required[dict[str, torch.Tensor]]


class Detector(torch.nn.Module):
    def __init__(self, config: Configuration) -> None:
        super().__init__()
        self.model = config.model.deploy()
        self.postprocessor = config.postprocessor.deploy()

    def forward(
        self, images: torch.Tensor, orig_target_sizes: torch.Tensor
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        return self.postprocessor(self.model(images), orig_target_sizes)


def golden_inputs() -> tuple[list[str], list[NDArray[np.float32]], list[NDArray[np.int64]]]:
    provenance: Provenance = json.loads(
        (ROOT / "tests/golden/upstream.provenance.json").read_text()
    )
    if len(provenance["files"]) != IMAGE_COUNT:
        raise ValueError(f"Expected {IMAGE_COUNT} pinned golden images")
    names: list[str] = []
    inputs: list[NDArray[np.float32]] = []
    sizes: list[NDArray[np.int64]] = []
    ImageFile.LOAD_TRUNCATED_IMAGES = True
    transforms = importlib.import_module("torchvision.transforms")
    transform: Callable[[Image.Image], torch.Tensor] = transforms.Compose(
        [transforms.Resize((IMAGE_SIZE, IMAGE_SIZE)), transforms.ToTensor()]
    )
    for asset in provenance["files"]:
        relative = f".cache/upstream/speciesnet/{provenance['commit']}/test_data/{asset['name']}"
        path = ROOT / relative
        acquire(path, asset)
        with Image.open(path) as source:
            image = source.convert("RGB")
            ImageOps.exif_transpose(image, in_place=True)
        resized = image.resize((IMAGE_SIZE, IMAGE_SIZE), Image.Resampling.BILINEAR)
        pixels = np.asarray(resized, dtype=np.float32).transpose(2, 0, 1)[None] / np.float32(255)
        np.testing.assert_array_equal(pixels, np.asarray(transform(image), dtype=np.float32)[None])
        names.append(relative)
        inputs.append(pixels)
        sizes.append(np.array([image.size], dtype=np.int64))
    generator = np.random.default_rng(SEED)
    for index, size in enumerate(((1920, 1080), (640, 960))):
        names.append(f"random-{index + 1}")
        inputs.append(generator.random((1, 3, IMAGE_SIZE, IMAGE_SIZE), dtype=np.float32))
        sizes.append(np.array([size], dtype=np.int64))
    return names, inputs, sizes


def prepare() -> None:
    require_disk_space()
    acquire(CHECKPOINT, {"url": CHECKPOINT_URL, **CHECKPOINT_INTEGRITY})
    package = distribution("PytorchWildlife")
    if package.version != "1.3.1":
        raise ValueError("The export requires PytorchWildlife 1.3.1")
    source = Path(str(package.locate_file("PytorchWildlife/models/detection/rtdetr_apache")))
    source_files = {
        str(path.relative_to(source)): integrity(path)
        for path in sorted(source.rglob("*"))
        if path.suffix in {".py", ".yml"}
    }
    sys.path.insert(0, str(source))
    config_type: Callable[..., Configuration] = importlib.import_module(
        "rtdetrv2_pytorch.src.core"
    ).YAMLConfig
    # The complete detector state replaces the backbone; avoid its unrelated pretrained download.
    config = config_type(
        str(source / "rtdetrv2_pytorch/configs/rtdetrv2/rtdetrv2_r18vd_120e_megadetector.yml"),
        PResNet={"pretrained": False},
    )
    checkpoint: Checkpoint = torch.load(CHECKPOINT, map_location="cpu", weights_only=False)
    state = checkpoint["ema"]["module"] if "ema" in checkpoint else checkpoint["model"]
    config.model.load_state_dict(state, strict=True)
    model = Detector(config).eval().cpu()
    torch.set_num_threads(1)
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    REFERENCE_DIR.mkdir(parents=True, exist_ok=True)
    names, inputs, sizes = golden_inputs()
    output = model_path("fp32")
    export: Callable[..., object] = importlib.import_module("torch.onnx").export
    from_numpy: Callable[[NDArray[np.float32] | NDArray[np.int64]], torch.Tensor] = (
        importlib.import_module("torch").from_numpy
    )
    with torch.inference_mode():
        export(
            model,
            (from_numpy(inputs[-2]), from_numpy(sizes[-2])),
            str(output),
            input_names=["images", "orig_target_sizes"],
            output_names=["labels", "boxes", "scores"],
            opset_version=OPSET,
            dynamo=False,
        )
        for index, (values, size) in enumerate(zip(inputs, sizes, strict=True)):
            labels, boxes, scores = model(from_numpy(values), from_numpy(size))
            np.savez_compressed(
                REFERENCE_DIR / f"{index:03}.npz",
                images=values,
                orig_target_sizes=size,
                labels=np.asarray(labels, dtype=np.int64),
                boxes=np.asarray(boxes, dtype=np.float32),
                scores=np.asarray(scores, dtype=np.float32),
            )
    check_model: Callable[..., None] = importlib.import_module("onnx.checker").check_model
    check_model(str(output), full_check=True)
    record: Reference = {
        "pytorchwildlife": package.version,
        "torch": torch.__version__,
        "device": "cpu",
        "seed": SEED,
        "opset": OPSET,
        "postprocessing": True,
        "cases": names,
        "golden_provenance": integrity(ROOT / "tests/golden/upstream.provenance.json"),
        "checkpoint": integrity(CHECKPOINT),
        "source_files": source_files,
        "fp32": integrity(output),
        "fixtures": [integrity(REFERENCE_DIR / f"{i:03}.npz") for i in range(len(names))],
        "images": {name: integrity(ROOT / name) for name in names[:IMAGE_COUNT]},
    }
    (REFERENCE_DIR / "reference.json").write_text(json.dumps(record, indent=2) + "\n")
    licence = next(path for path in package.files or [] if str(path).endswith("/LICENSE"))
    shutil.copyfile(str(package.locate_file(licence)), EXPORT_DIR / "LICENSE-PytorchWildlife")
    print(
        f"Exported opset {OPSET} with postprocessing; "
        f"saved {IMAGE_COUNT} golden and 2 random CPU cases"
    )
