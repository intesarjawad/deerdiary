import argparse
import importlib
import sys
from collections.abc import Callable
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description="Export and verify MDV6-apa-rtdetr-c on CPU.")
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--prepare-reference", action="store_true")
    action.add_argument("--check", action="store_true")
    args = parser.parse_args()
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    module = "export.rtdetr_reference" if args.prepare_reference else "export.rtdetr_verify"
    run: Callable[[], None] = getattr(
        importlib.import_module(module), "prepare" if args.prepare_reference else "check"
    )
    run()


if __name__ == "__main__":
    main()
