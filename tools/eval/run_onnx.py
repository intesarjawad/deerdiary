import importlib
import sys
from collections.abc import Callable
from pathlib import Path


def main() -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    run: Callable[[], None] = importlib.import_module("eval.onnx_selection").main
    run()


if __name__ == "__main__":
    main()
