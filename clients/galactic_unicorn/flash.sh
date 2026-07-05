#!/usr/bin/env bash
# flash.sh — Quick launcher for the Galactic Unicorn firmware flasher
#
# Usage:
#   ./flash.sh                          # interactive (prompts for Wi-Fi)
#   ./flash.sh --model stellar          # Stellar Unicorn 16×16
#   ./flash.sh --model cosmic           # Cosmic Unicorn 32×32
#   ./flash.sh --ssid MyNet --password secret
#   ./flash.sh --no-flash               # skip UF2, only copy Python files
#   ./flash.sh --port /dev/ttyACM0      # specify serial port
#   ./flash.sh --dry-run                # preview without making changes
#
# All arguments are passed through to flash.py — run with --help for full list.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Check Python 3 ──────────────────────────────────────────────────────────
if ! command -v python3 &>/dev/null; then
    echo "✗ python3 not found. Please install Python 3.8 or later." >&2
    exit 1
fi

PYTHON_VERSION=$(python3 -c "import sys; print(sys.version_info.major * 10 + sys.version_info.minor)")
if [ "$PYTHON_VERSION" -lt 38 ]; then
    echo "✗ Python 3.8 or later is required (found $(python3 --version))." >&2
    exit 1
fi

# ── Check / install mpremote ────────────────────────────────────────────────
if ! command -v mpremote &>/dev/null; then
    echo "→ mpremote not found. Installing…"
    if python3 -m pip install --quiet mpremote; then
        echo "✓ mpremote installed"
    else
        echo "✗ Failed to install mpremote. Run manually: pip install mpremote" >&2
        exit 1
    fi
fi

# ── Check / install requests (used for GitHub API) ──────────────────────────
if ! python3 -c "import urllib.request" &>/dev/null 2>&1; then
    echo "✗ Python urllib not available (should be in stdlib)." >&2
    exit 1
fi

# ── Run the flasher ─────────────────────────────────────────────────────────
exec python3 "$SCRIPT_DIR/flash.py" "$@"
