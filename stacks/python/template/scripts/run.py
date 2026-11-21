#!/usr/bin/env python3
"""Run a module of this project the way a user would (dlm python stack; stdlib only; gate definition file).

  .venv/bin/python scripts/run.py <module> [args...]     e.g.  .venv/bin/python scripts/run.py greet Grace

Puts the src/ next to this script first on sys.path and runs <module> as __main__ (its __main__.py for a package),
with sys.argv = [<module>, args...]. The src used is always this tree's own: in a dlm copy (sandbox, acceptance copy,
merge tree) that is the copy's code, never the root's, so evidence tests the branch. Nothing is installed into .venv.
"""
import importlib.util
import runpy
import sys
from pathlib import Path


def module_missing(module):
    """True only when <module> itself (or a parent package of it) does not exist under the path.
    An ImportError raised inside the project's own code is not swallowed: it propagates with its traceback."""
    try:
        return importlib.util.find_spec(module) is None
    except ModuleNotFoundError as e:
        parts = module.split(".")
        return e.name in {".".join(parts[: i + 1]) for i in range(len(parts))}


def main():
    if len(sys.argv) < 2 or sys.argv[1].startswith("-"):
        print("usage: .venv/bin/python scripts/run.py <module> [args...]", file=sys.stderr)
        return 2
    src = Path(__file__).resolve().parent.parent / "src"
    sys.path.insert(0, str(src))
    module = sys.argv[1]
    if module_missing(module):
        print(f"找不到模組 {module}(在 src/ 底下)", file=sys.stderr)
        return 2
    sys.argv = [module, *sys.argv[2:]]
    runpy.run_module(module, run_name="__main__", alter_sys=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
