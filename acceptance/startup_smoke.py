"""T6 GUI startup smoke test for Windows desktop sessions.

Launches the real CustomTkinter window, closes it after ``--hold-ms`` and
prints a single marker line.  It performs no network access.

Usage (from the repository root):
    .venv/Scripts/python.exe acceptance/startup_smoke.py --hold-ms 1200
"""

from __future__ import annotations

import argparse
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from main import ArchiveSearchApp  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hold-ms", type=int, default=1200)
    args = parser.parse_args()

    started = time.time()
    app = ArchiveSearchApp()
    app.after(max(0, args.hold_ms), app.destroy)
    app.mainloop()
    elapsed = time.time() - started
    print(f"STARTUP_SMOKE_OK hold_ms={args.hold_ms} elapsed_s={elapsed:.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
