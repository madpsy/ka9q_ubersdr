#!/usr/bin/env bash
# deploy.sh — Push updated firmware files to a running Galactic Unicorn
#
# Use this after the initial flash (flash.sh) when you've made code changes
# and just want to update the Python files without re-flashing the UF2 or
# re-entering Wi-Fi credentials.
#
# Usage:
#   ./deploy.sh                        # auto-detect port, copy all files
#   ./deploy.sh --port /dev/ttyACM0    # specify port
#   ./deploy.sh --file main.py         # copy only one file
#   ./deploy.sh --no-reset             # copy files but don't reset
#   ./deploy.sh --monitor              # open REPL after deploy to see output
#
# The Pico W must already be running MicroPython (not in BOOTSEL mode).
# config.py on the device is NOT overwritten — your Wi-Fi credentials are safe.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIRMWARE_DIR="$SCRIPT_DIR/firmware"

PORT=""
FILES=()
NO_RESET=0
MONITOR=0

# ── Parse arguments ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --port)
            PORT="$2"; shift 2 ;;
        --file)
            FILES+=("$2"); shift 2 ;;
        --no-reset)
            NO_RESET=1; shift ;;
        --monitor)
            MONITOR=1; shift ;;
        --help|-h)
            sed -n '2,20p' "$0" | sed 's/^# \?//'
            exit 0 ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1 ;;
    esac
done

# Default: copy all firmware files (not config.py — that has credentials)
if [[ ${#FILES[@]} -eq 0 ]]; then
    FILES=("display_engine.py" "sound_engine.py" "main.py")
fi

# ── Check mpremote ───────────────────────────────────────────────────────────
# Store mpremote as an array so it expands correctly whether it's a bare
# command ("mpremote") or a module invocation ("python3" "-m" "mpremote").
MPREMOTE=()
if command -v mpremote &>/dev/null; then
    MPREMOTE=(mpremote)
elif python3 -m mpremote version &>/dev/null 2>&1; then
    MPREMOTE=(python3 -m mpremote)
else
    echo "→ mpremote not found. Installing…"
    python3 -m pip install --quiet mpremote
    MPREMOTE=(python3 -m mpremote)
fi

# ── Auto-detect port ─────────────────────────────────────────────────────────
if [[ -z "$PORT" ]]; then
    # Try common Linux/macOS ports
    for candidate in /dev/ttyACM0 /dev/ttyACM1 /dev/cu.usbmodem* /dev/tty.usbmodem*; do
        if [[ -e "$candidate" ]]; then
            PORT="$candidate"
            break
        fi
    done

    if [[ -z "$PORT" ]]; then
        echo "✗ Could not auto-detect Pico W serial port." >&2
        echo "  Plug in the Pico W and try again, or use: --port /dev/ttyACM0" >&2
        exit 1
    fi
    echo "→ Auto-detected port: $PORT"
fi

# ── Copy files ───────────────────────────────────────────────────────────────
echo ""
echo "● Deploying firmware to $PORT"
for file in "${FILES[@]}"; do
    local_path="$FIRMWARE_DIR/$file"
    if [[ ! -f "$local_path" ]]; then
        echo "✗ File not found: $local_path" >&2
        exit 1
    fi
    echo "  → $file"
    "${MPREMOTE[@]}" connect "$PORT" cp "$local_path" ":$file"
done
echo "✓ Files copied"

# ── Reset or monitor ─────────────────────────────────────────────────────────
if [[ "$MONITOR" -eq 1 ]]; then
    echo ""
    echo "● Opening serial monitor (Ctrl+] or Ctrl+X to exit)"
    echo ""
    exec "${MPREMOTE[@]}" connect "$PORT" repl
elif [[ "$NO_RESET" -eq 0 ]]; then
    echo "→ Resetting Pico W…"
    "${MPREMOTE[@]}" connect "$PORT" reset
    echo "✓ Done — device is rebooting"
else
    echo "→ Skipping reset (--no-reset)"
fi
