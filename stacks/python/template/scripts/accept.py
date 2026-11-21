#!/usr/bin/env python3
"""Acceptance entry point for the dlm python stack (stdlib only; gate definition file, workers may not change it).

  accept.py <feature> ...   run the step modules under features/steps/** whose text contains that exact feature path.
                            A feature path with no module is an error (exit 1): nothing would test it.
  accept.py                 run every step module, except those that only reference features listed in
                            .dlm/pending-features.json (approved nodes not done yet: their scenarios are always red).
                            No step modules at all -> exit 0 with a note.

pytest runs with the same interpreter (sys.executable -m pytest), so `.venv/bin/python scripts/accept.py` uses the venv.
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

STEPS = Path("features/steps")
FEATURE_REF = re.compile(r"""["']((?:features|docs/integration)/[^"'\s]+?\.feature)["']""")


def step_modules():
    if not STEPS.is_dir():
        return []
    return sorted(
        p for p in STEPS.rglob("*.py")
        if p.name != "__init__.py" and "__pycache__" not in p.parts
    )


def read(p):
    try:
        return p.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""


def pending_features():
    try:
        data = json.loads(Path(".dlm/pending-features.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return set()
    return {str(x) for x in data} if isinstance(data, list) else set()


def norm(arg):
    # features/x/v1.feature:12 -> features/x/v1.feature ; ./features/... -> features/...
    path = re.sub(r"(:\d+)+$", "", arg)
    return path[2:] if path.startswith("./") else path


def pytest(files, extra):
    cmd = [sys.executable, "-m", "pytest", "-q", *extra, *[str(f) for f in files]]
    return subprocess.call(cmd)


def main(argv):
    extra = [a for a in argv if a.startswith("-")]
    features = [norm(a) for a in argv if not a.startswith("-")]
    modules = step_modules()
    texts = {m: read(m) for m in modules}

    if features:
        chosen = []
        missing = []
        for f in features:
            hits = [m for m in modules if f in texts[m]]
            if not hits:
                missing.append(f)
            chosen.extend(h for h in hits if h not in chosen)
        if missing:
            for f in missing:
                print(f"accept.py: no step module under {STEPS}/ references {f} "
                      f'(write scenarios("{f}") in features/steps/<capability>/test_<capability>_<version>.py)',
                      file=sys.stderr)
            return 1
        return pytest(chosen, extra)

    pending = pending_features()
    chosen = []
    for m in modules:
        refs = set(FEATURE_REF.findall(texts[m]))
        if refs and refs <= pending:
            continue
        chosen.append(m)
    if not chosen:
        print("accept.py: no step modules to run (none written yet, or all belong to nodes not done yet)")
        return 0
    return pytest(chosen, extra)


if __name__ == "__main__":
    os.chdir(Path(__file__).resolve().parent.parent)
    sys.exit(main(sys.argv[1:]))
