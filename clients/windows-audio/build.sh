#!/usr/bin/env bash
# build.sh — Build UberSDRAudio for Linux and cross-compile for Windows
#
# Requirements:
#   sudo apt install gcc-mingw-w64-x86-64 libopus-dev libasound2-dev
#
# Usage:
#   ./build.sh              # build both Linux and Windows binaries
#   ./build.sh /some/path   # place the Windows .exe at the given path

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_WIN="${1:-${SCRIPT_DIR}/UberSDRAudio.exe}"
OUTPUT_LIN="${SCRIPT_DIR}/UberSDRAudio"

cd "${SCRIPT_DIR}"

# Ensure dependencies are resolved
go mod tidy

# ── Linux build ───────────────────────────────────────────────────────────────
echo "Building UberSDRAudio for Linux (amd64)..."
echo "Output: ${OUTPUT_LIN}"
echo ""

# Requires: libopus-dev libasound2-dev (for oto/ALSA)
CGO_ENABLED=1 \
GOOS=linux \
GOARCH=amd64 \
go build \
    -o "${OUTPUT_LIN}" \
    .

echo "Done: ${OUTPUT_LIN}"
ls -lh "${OUTPUT_LIN}"
echo ""

# ── Windows build ─────────────────────────────────────────────────────────────
# Check for mingw cross-compiler
if ! command -v x86_64-w64-mingw32-gcc &>/dev/null; then
    echo "WARNING: x86_64-w64-mingw32-gcc not found — skipping Windows build."
    echo "Install it with:  sudo apt install gcc-mingw-w64-x86-64"
    exit 0
fi

# Check for windres (needed for icon embedding)
if ! command -v x86_64-w64-mingw32-windres &>/dev/null; then
    echo "WARNING: x86_64-w64-mingw32-windres not found — skipping Windows build."
    echo "Install it with:  sudo apt install gcc-mingw-w64-x86-64"
    exit 0
fi

echo "Building UberSDRAudio.exe for Windows (amd64)..."
echo "Output: ${OUTPUT_WIN}"
echo ""

# Compile Windows resource file (embeds icon into .exe)
echo "Compiling resource file..."
x86_64-w64-mingw32-windres resource.rc -O coff -o resource.syso

# Cross-compile
GOOS=windows \
GOARCH=amd64 \
CGO_ENABLED=1 \
CC=x86_64-w64-mingw32-gcc \
go build \
    -ldflags="-H windowsgui" \
    -o "${OUTPUT_WIN}" \
    .

echo ""
echo "Done: ${OUTPUT_WIN}"
ls -lh "${OUTPUT_WIN}"
