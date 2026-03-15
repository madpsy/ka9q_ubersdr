#!/usr/bin/env bash
# run.sh - Run the UberSDR benchmark tool inside a virtual environment.
#
# Creates the venv and installs dependencies on first run (or if .venv is
# missing), then passes all arguments directly to benchmark.py.
#
# Usage:
#   cd clients/benchmark
#   ./run.sh --url http://localhost:8073 --users 50 -f 14200000 -m usb
#   ./run.sh --url http://localhost:8073 --users 100 --threads 10 --duration 300 \
#            -f 7100000 -m lsb --spectrum-zoom 500

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

VENV_DIR=".venv"
PYTHON="${PYTHON:-python3}"

# ---------------------------------------------------------------------------
# 1. Create venv if it doesn't exist
# ---------------------------------------------------------------------------
if [ ! -d "$VENV_DIR" ]; then
    echo "==> Creating virtual environment in $VENV_DIR ..."
    "$PYTHON" -m venv "$VENV_DIR"
fi

# Activate venv
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

# ---------------------------------------------------------------------------
# 2. Install / sync dependencies (fast no-op if already up to date)
# ---------------------------------------------------------------------------
pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt

# ---------------------------------------------------------------------------
# 3. Run benchmark, forwarding all arguments
# ---------------------------------------------------------------------------
exec python benchmark.py "$@"
