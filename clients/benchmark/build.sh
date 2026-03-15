#!/usr/bin/env bash
# build.sh - Build a single-file executable for the UberSDR benchmark tool.
#
# Creates a Python venv, installs dependencies + PyInstaller, then produces
# a self-contained binary at:
#   clients/benchmark/dist/benchmark
#
# Usage:
#   cd clients/benchmark
#   ./build.sh
#
# The resulting binary can be run without Python installed:
#   ./dist/benchmark --url ws://localhost:8073 --users 50 -f 14200000 -m usb

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

VENV_DIR=".venv"
PYTHON="${PYTHON:-python3}"

echo "==> Using Python: $($PYTHON --version)"

# ---------------------------------------------------------------------------
# 1. Create / reuse virtual environment
# ---------------------------------------------------------------------------
if [ ! -d "$VENV_DIR" ]; then
    echo "==> Creating virtual environment in $VENV_DIR ..."
    "$PYTHON" -m venv "$VENV_DIR"
else
    echo "==> Reusing existing virtual environment in $VENV_DIR"
fi

# Activate venv
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

# ---------------------------------------------------------------------------
# 2. Install / upgrade dependencies
# ---------------------------------------------------------------------------
echo "==> Upgrading pip ..."
pip install --quiet --upgrade pip

echo "==> Installing requirements ..."
pip install --quiet -r requirements.txt

echo "==> Installing PyInstaller ..."
pip install --quiet pyinstaller

# ---------------------------------------------------------------------------
# 3. Build single-file binary with PyInstaller
# ---------------------------------------------------------------------------
echo "==> Running PyInstaller ..."
pyinstaller \
    --onefile \
    --name benchmark \
    --distpath dist \
    --workpath build \
    --specpath build \
    --clean \
    --noconfirm \
    benchmark.py

# ---------------------------------------------------------------------------
# 4. Done
# ---------------------------------------------------------------------------
BINARY="$SCRIPT_DIR/dist/benchmark"
echo ""
echo "==> Build complete: $BINARY"
echo "    Size: $(du -sh "$BINARY" | cut -f1)"
echo ""
echo "    Run with:"
echo "      $BINARY --url http://localhost:8073 --users 10 -f 14200000 -m usb"
