import argparse
import importlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

MEGADETECTOR_FILE = "megadetector.json"
CAMTRAP_SCHEMA_BASE = "https://raw.githubusercontent.com/tdwg/camtrap-dp/1.0.2"
CAMTRAP_PROFILE = f"{CAMTRAP_SCHEMA_BASE}/camtrap-dp-profile.json"


def run(command: list[str], directory: Path) -> int:
    print("$ " + " ".join(command), flush=True)
    return subprocess.run(command, cwd=directory, check=False).returncode


def validate_datapackage(directory: Path) -> int:
    path = directory / "datapackage.json"
    if not path.is_file():
        print(f"missing {path}")
        return 1
    descriptor = json.loads(path.read_text())
    if descriptor.get("profile") != CAMTRAP_PROFILE:
        print(f"Camtrap DP validation requires profile {CAMTRAP_PROFILE}")
        return 1
    schemas = {
        resource["name"]: resource.get("schema") for resource in descriptor.get("resources", [])
    }
    for name in ("deployments", "media", "observations"):
        expected = f"{CAMTRAP_SCHEMA_BASE}/{name}-table-schema.json"
        if schemas.get(name) != expected:
            print(f"Camtrap DP validation requires {name} schema {expected}")
            return 1
    return run([sys.executable, "-m", "frictionless", "validate", path.name], directory)


def validate_megadetector(directory: Path) -> int:
    path = directory / MEGADETECTOR_FILE
    if not path.is_file():
        print(f"missing {path}")
        return 1
    try:
        module = importlib.import_module("megadetector.postprocessing.validate_batch_results")
    except ImportError:
        print("megadetector is not installed; skipping the external MegaDetector check")
        return 0
    validator: Any = module.__dict__["validate_batch_results"]
    results = validator(str(path))["validation_results"]
    for warning in results["warnings"]:
        print(f"warning: {warning}")
    for error in results["errors"]:
        print(f"error: {error}")
    return 1 if results["errors"] else 0


def resolve_directory(value: str) -> Path:
    candidate = Path(value)
    if candidate.is_dir():
        return candidate
    repository_path = Path(__file__).resolve().parents[2] / candidate
    return repository_path if repository_path.is_dir() else candidate


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate exported Camtrap DP and MegaDetector files."
    )
    parser.add_argument("directory", nargs="?", default="tests/e2e/fixtures/export")
    parser.add_argument(
        "--camtrap-only", action="store_true", help="Validate only the Camtrap DP package."
    )
    args = parser.parse_args()
    directory = resolve_directory(args.directory)
    if not directory.is_dir():
        print(f"missing export directory: {directory}")
        return 1
    datapackage = validate_datapackage(directory)
    megadetector = 0 if args.camtrap_only else validate_megadetector(directory)
    return datapackage or megadetector


if __name__ == "__main__":
    raise SystemExit(main())
