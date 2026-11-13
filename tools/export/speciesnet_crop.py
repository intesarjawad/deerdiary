import argparse
import importlib
import sys
from collections.abc import Callable
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description="Export and verify the v4.0.3a crop classifier.")
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument(
        "--prepare-reference",
        action="store_true",
        help="Export fp32 and save PyTorch logits using the reference dependency group.",
    )
    action.add_argument(
        "--check",
        action="store_true",
        help="Write fp16, check saved PyTorch logits and update the local manifest (ONNX group).",
    )
    args = parser.parse_args()
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    module = "export.reference" if args.prepare_reference else "export.verify"
    run: Callable[[], None] = getattr(
        importlib.import_module(module), "prepare" if args.prepare_reference else "check"
    )
    run()


if __name__ == "__main__":
    main()
