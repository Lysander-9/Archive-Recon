#!/usr/bin/env sh
# Cross-platform launcher for macOS / Linux.
# Prefers a project .venv, then python3, then python.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_SCRIPT="$SCRIPT_DIR/main.py"

if [ ! -f "$APP_SCRIPT" ]; then
    echo "[ERROR] main.py not found next to this script: $APP_SCRIPT" >&2
    exit 1
fi

if [ -x "$SCRIPT_DIR/.venv/bin/python" ]; then
    PY="$SCRIPT_DIR/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
    PY=python3
elif command -v python >/dev/null 2>&1; then
    PY=python
else
    echo "[ERROR] No Python 3 found. Install Python 3.10+ with Tk support, or run: uv venv .venv" >&2
    exit 1
fi

if ! "$PY" -c "import tkinter, customtkinter, requests" >/dev/null 2>&1; then
    echo "[ERROR] Tkinter or project dependencies are missing for: $PY" >&2
    echo "        Install them with: $PY -m pip install -r \"$SCRIPT_DIR/requirements.txt\"" >&2
    echo "        On Debian/Ubuntu Tkinter comes from the python3-tk package." >&2
    exit 1
fi

exec "$PY" "$APP_SCRIPT"
