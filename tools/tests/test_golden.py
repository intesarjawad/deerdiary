import json
import subprocess
import sys
from pathlib import Path

import pytest

from golden import run_cli

GOLDEN = Path(__file__).resolve().parents[2] / "tests/golden"


@pytest.mark.parametrize("country", ["none", "usa", "gbr"])
def test_ensemble_goldens_use_the_serialized_raw_capture(country: str) -> None:
    raw = json.loads((GOLDEN / "speciesnet_cli.raw.json").read_text())
    full = json.loads((GOLDEN / f"speciesnet_cli.{country}.json").read_text())
    expected = {image["filepath"]: image["detections"] for image in raw["predictions"]}
    actual = {
        image["filepath"]: [
            {key: value for key, value in detection.items() if key != "processed_classification"}
            for detection in image["detections"]
        ]
        for image in full["predictions"]
    }
    assert actual == expected
    elephant = next(
        image
        for image in full["predictions"]
        if image["filepath"].endswith("/african_elephants.jpg")
    )
    assert elephant["detections"][3]["processed_classification"] == {
        "class": "f2d233e3-80e3-433d-9687-e29ecc7a467a;mammalia;;;;;mammal",
        "score": 0.941,
        "source": "classifier+rollup_to_class",
    }


def test_cli_regeneration_keeps_serialized_box_correction(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    golden = tmp_path / "golden"
    images = golden / "upstream"
    images.mkdir(parents=True)
    for index in range(run_cli.IMAGE_COUNT):
        (images / f"{index}.jpg").touch()
    work = tmp_path / "captures"
    calls: list[list[str]] = []

    def run(
        command: list[str], *, cwd: Path, env: dict[str, str], check: bool
    ) -> subprocess.CompletedProcess[str]:
        assert check
        assert cwd == run_cli.ROOT
        assert env["OMP_NUM_THREADS"] == "1"
        assert command[command.index("--max_classifications_per_image") + 1] == "5"
        assert command[command.index("--max_classifications_per_detection") + 1] == "5"
        modes = ["--classifier_only", "--detector_only", "--ensemble_only"]
        assert sum(mode in command for mode in modes) <= 1
        calls.append(command)
        output = Path(command[command.index("--predictions_json") + 1])
        country = (
            command[command.index("--country") + 1].lower() if "--country" in command else "none"
        )
        if "--detector_only" in command or "--classifier_only" in command:
            fixture = json.loads((GOLDEN / "speciesnet_cli.raw.json").read_text())
            if "--detector_only" in command:
                for image in fixture["predictions"]:
                    for detection in image["detections"]:
                        detection.pop("raw_classifications", None)
        else:
            fixture = json.loads((GOLDEN / f"speciesnet_cli.{country}.json").read_text())
            if "--ensemble_only" in command:
                assert command[command.index("--detections_json") + 1] == str(
                    work / "detections.json"
                )
                assert command[command.index("--classifications_json") + 1] == str(
                    work / "classifications.json"
                )
            else:
                elephant = next(
                    image
                    for image in fixture["predictions"]
                    if image["filepath"].endswith("/african_elephants.jpg")
                )
                elephant["detections"][3]["processed_classification"]["score"] = 0.741
        output.write_text(json.dumps(fixture, indent=2) + "\n")
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(run_cli, "GOLDEN", golden)
    monkeypatch.setattr(sys, "argv", ["run_cli.py", "--work-dir", str(work)])
    monkeypatch.setattr(run_cli.subprocess, "run", run)
    run_cli.main()
    assert len(calls) == 8
    assert all("--ensemble_only" in call for call in calls[5:])
    assert (golden / "speciesnet_cli.raw.json").read_bytes() == (
        GOLDEN / "speciesnet_cli.raw.json"
    ).read_bytes()
    for country in ["none", "usa", "gbr"]:
        actual = json.loads((golden / f"speciesnet_cli.{country}.json").read_text())
        expected = json.loads((GOLDEN / f"speciesnet_cli.{country}.json").read_text())
        assert actual == expected
