"""Checks the project layout the gate relies on: src/ is on the import path.

It also keeps `pytest -q src` from exiting 5 ("no tests collected") before the first capability has unit tests.
"""
import sys
from pathlib import Path


def test_src_is_on_the_import_path():
    src = Path(__file__).resolve().parent
    assert any(Path(p).resolve() == src for p in sys.path if p), sys.path
