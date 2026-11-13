import importlib
import json
import os
import shutil
from collections.abc import Callable
from importlib.metadata import distribution
from pathlib import Path
from typing import Protocol

import numpy as np
import torch
from numpy.typing import NDArray
from PIL import Image, ImageFile, ImageOps

from export.speciesnet_source import (
    EXPORT_DIR,
    IMAGE_COUNT,
    IMAGE_SIZE,
    LABEL_COUNT,
    MODEL_DIR,
    MODEL_HANDLE,
    RAW_PATH,
    REFERENCE_DIR,
    ROOT,
    TOP_K,
    Reference,
    integrity,
    read_info,
)
from golden.run_cli import load_predictions

BBOX_COORDINATES = 4
CLASSIFICATION_THRESHOLD = 0.1


class Transforms(Protocol):
    def pil_to_tensor(self, pic: Image.Image) -> torch.Tensor: ...
    def convert_image_dtype(self, image: torch.Tensor, dtype: torch.dtype) -> torch.Tensor: ...
    def crop(
        self, img: torch.Tensor, top: int, left: int, height: int, width: int
    ) -> torch.Tensor: ...
    def resize(self, img: torch.Tensor, size: list[int], *, antialias: bool) -> torch.Tensor: ...


class Crop(Protocol):
    @property
    def arr(self) -> NDArray[np.uint8]: ...


class OfficialClassifier(Protocol):
    def preprocess(self, img: Image.Image, bboxes: list[object]) -> list[Crop]: ...


def crop_pixels(image: Image.Image, bbox: list[float]) -> NDArray[np.uint8]:
    transforms: Transforms = importlib.import_module("torchvision.transforms").functional
    if len(bbox) != BBOX_COORDINATES or not all(np.isfinite(bbox)):
        raise ValueError(f"Invalid detection box: {bbox}")
    xmin, ymin, width, height = bbox
    tensor = transforms.convert_image_dtype(transforms.pil_to_tensor(image), torch.float32)
    cropped = transforms.crop(
        tensor,
        int(ymin * image.height),
        int(xmin * image.width),
        int(height * image.height),
        int(width * image.width),
    )
    resized = transforms.resize(cropped, [IMAGE_SIZE, IMAGE_SIZE], antialias=False)
    return np.asarray(
        transforms.convert_image_dtype(resized, torch.uint8).permute(1, 2, 0), dtype=np.uint8
    )


def golden_inputs() -> tuple[list[str], list[NDArray[np.float32]]]:
    classifier_type: Callable[..., OfficialClassifier] = importlib.import_module(
        "speciesnet.classifier"
    ).SpeciesNetClassifier
    box_type: Callable[..., object] = importlib.import_module("speciesnet.utils").BBox
    classifier = classifier_type(str(MODEL_DIR), device="cpu")
    predictions = load_predictions(RAW_PATH)["predictions"]
    if len({p["filepath"] for p in predictions}) != IMAGE_COUNT:
        raise ValueError("Golden image paths must be unique")
    names: list[str] = []
    inputs: list[NDArray[np.float32]] = []
    ImageFile.LOAD_TRUNCATED_IMAGES = True
    for prediction in predictions:
        image_path = ROOT / prediction["filepath"]
        with Image.open(image_path) as source:
            image = source.convert("RGB")
            ImageOps.exif_transpose(image, in_place=True)
        selected = [
            i
            for i, detection in enumerate(prediction["detections"])
            if "raw_classifications" in detection
        ]
        eligible = [
            i
            for i, d in enumerate(prediction["detections"])
            if d["conf"] >= CLASSIFICATION_THRESHOLD
        ]
        expected = sorted(
            sorted(eligible, key=lambda i: prediction["detections"][i]["conf"], reverse=True)[
                :TOP_K
            ]
        )
        if selected != expected:
            raise ValueError(f"CLI crop selection disagrees: {prediction['filepath']}")
        for index in selected:
            bbox = prediction["detections"][index]["bbox"]
            pixels = crop_pixels(image, bbox)
            official = classifier.preprocess(image, [box_type(*bbox)])
            np.testing.assert_array_equal(pixels, official[0].arr)
            names.append(f"{prediction['filepath']}#{index}")
            inputs.append(pixels.astype(np.float32)[None, ...] / np.float32(255))
    if not inputs:
        raise ValueError("The CLI produced no classified crops")
    return names, inputs


def prepare() -> None:
    os.environ["KAGGLEHUB_CACHE"] = str(ROOT / ".cache/kagglehub")
    download: Callable[[str], str] = importlib.import_module("kagglehub").model_download
    if Path(download(MODEL_HANDLE)) != MODEL_DIR:
        raise ValueError("Kaggle download did not use the workspace cache")
    info = read_info()
    if not RAW_PATH.is_file():
        raise ValueError("Run golden/run_cli.py with the reference group first")
    torch.set_num_threads(1)
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    REFERENCE_DIR.mkdir(parents=True, exist_ok=True)
    names, inputs = golden_inputs()
    golden_count = len(inputs)
    generator = np.random.default_rng(20261104)
    for batch_size in (1, 2):
        names.append(f"random-batch-{batch_size}")
        inputs.append(generator.random((batch_size, IMAGE_SIZE, IMAGE_SIZE, 3), dtype=np.float32))
    model: torch.nn.Module = torch.load(
        MODEL_DIR / info["classifier"], map_location="cpu", weights_only=False
    ).eval()
    output = EXPORT_DIR / "speciesnet-v4.0.3a-crop.fp32.onnx"
    export: Callable[..., object] = importlib.import_module("torch.onnx").export
    from_numpy: Callable[[NDArray[np.float32]], torch.Tensor] = importlib.import_module(
        "torch"
    ).from_numpy
    with torch.inference_mode():
        export(
            model,
            (from_numpy(inputs[-2]),),
            str(output),
            input_names=["image"],
            output_names=["logits"],
            dynamic_axes={"image": {0: "batch"}, "logits": {0: "batch"}},
            opset_version=17,
            dynamo=False,
        )
        for index, values in enumerate(inputs):
            logits: torch.Tensor = model(from_numpy(values))
            if tuple(logits.shape) != (values.shape[0], LABEL_COUNT):
                raise ValueError(f"Unexpected classifier output: {logits.shape}")
            np.savez_compressed(
                REFERENCE_DIR / f"{index:03}.npz",
                image=values,
                logits=np.asarray(logits, dtype=np.float32),
            )
    check_model: Callable[..., None] = importlib.import_module("onnx.checker").check_model
    check_model(str(output), full_check=True)
    for filename in (info["classifier_labels"], info["taxonomy"], info["geofence"]):
        shutil.copyfile(MODEL_DIR / filename, EXPORT_DIR / filename)
    shutil.copyfile(MODEL_DIR / "info.json", EXPORT_DIR / "info.json")
    package = distribution("speciesnet")
    licence = next(path for path in package.files or [] if str(path).endswith("/licenses/LICENSE"))
    (EXPORT_DIR / "LICENSE").write_text(package.locate_file(licence).read_text())
    (EXPORT_DIR / "README.md").write_text(
        "# SpeciesNet v4.0.3a crop classifier\n\n"
        "Licence: Apache-2.0. Upstream model and data: Google SpeciesNet, "
        "https://www.kaggle.com/models/google/speciesnet/pyTorch/v4.0.3a/1.\n\n"
        "Exported from the always_crop checkpoint with SpeciesNet 5.0.6 and ONNX opset 17. "
        "Input image is float32 NHWC [batch,480,480,3] in 0..1 after full-resolution "
        "detection crop, bilinear resize without antialiasing, uint8 truncation and /255. "
        "Output logits is float32 [batch,2498], ordered by the labels file. "
        "Both fp32 and fp16 retain float32 input/output.\n\n"
        "Labels, taxonomy and geofence are copied unchanged from the versioned bundle. "
        "See info.json for their upstream filenames and parity.json for verification. "
        "Published repository placeholder: <owner>/deerdiary-speciesnet-v4.0.3a-crop-onnx. "
        "Publication is pending; no files have been uploaded. "
        "Browser precision selection remains pending ADR 0003.\n"
    )
    record: Reference = {
        "speciesnet_pypi": "5.0.6",
        "torch": torch.__version__,
        "seed": 20261104,
        "device": "cpu",
        "golden_images": IMAGE_COUNT,
        "golden_crops": golden_count,
        "cases": names,
        "raw_golden": integrity(RAW_PATH),
        "checkpoint": integrity(MODEL_DIR / info["classifier"]),
        "fp32": integrity(output),
        "fixtures": [integrity(REFERENCE_DIR / f"{i:03}.npz") for i in range(len(names))],
        "images": {
            p["filepath"]: integrity(ROOT / p["filepath"])
            for p in load_predictions(RAW_PATH)["predictions"]
        },
    }
    (REFERENCE_DIR / "reference.json").write_text(json.dumps(record, indent=2) + "\n")
    print(f"Exported fp32; saved PyTorch logits for {golden_count} CLI crops and 2 random batches")


if __name__ == "__main__":
    prepare()
