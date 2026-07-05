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
#   ./flash.sh --monitor                # open REPL after flashing to see boot output
#   ./flash.sh --dry-run                # preview without making changes
#
# All arguments are passed through to flash.py — run with --help for full list.
#
# ─────────────────────────────────────────────────────────────────────────────
# IMPORTANT: Model-specific firmware
# ─────────────────────────────────────────────────────────────────────────────
# Each Unicorn board needs its OWN Pimoroni MicroPython build.
# The generic "picow-*.uf2" does NOT include the galactic/stellar/cosmic module.
# This script downloads the correct model-specific UF2 automatically.
#
# ─────────────────────────────────────────────────────────────────────────────
# BOOTSEL mode (how to enter firmware flash mode)
# ─────────────────────────────────────────────────────────────────────────────
# When prompted to flash the UF2:
#   1. UNPLUG the Pico W from USB
#   2. Hold the BOOTSEL button (small white button on the board)
#   3. While holding BOOTSEL, plug in the USB cable
#   4. Release BOOTSEL
#   The Pico W appears as a USB drive called RPI-RP2
#   This script detects it and copies the UF2 automatically
#   The Pico W reboots itself — do NOT unplug it during flashing
#
# On Linux, after copying the UF2 the script runs 'umount' on the drive.
# This flushes the write buffer and triggers the RP2040 bootloader to flash.
# Without umount, the flash may not complete reliably.

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
# mpremote is the official MicroPython file transfer tool.
# We prefer 'python3 -m mpremote' over bare 'mpremote' because on systems
# with multiple Python environments (e.g. platformio) the mpremote script
# may not be on PATH even after 'pip install mpremote'.
MPREMOTE_OK=0
if command -v mpremote &>/dev/null; then
    MPREMOTE_OK=1
elif python3 -m mpremote version &>/dev/null 2>&1; then
    MPREMOTE_OK=1
fi

if [ "$MPREMOTE_OK" -eq 0 ]; then
    echo "→ mpremote not found. Installing…"
    if python3 -m pip install --quiet mpremote; then
        echo "✓ mpremote installed"
    else
        echo "✗ Failed to install mpremote. Run manually: pip install mpremote" >&2
        exit 1
    fi
fi

# ── Run the flasher ─────────────────────────────────────────────────────────
exec python3 "$SCRIPT_DIR/flash.py" "$@"
