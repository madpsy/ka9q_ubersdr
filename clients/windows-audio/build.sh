#!/usr/bin/env bash
# build.sh — Cross-compile UberSDRAudio.exe for Windows from Linux
#
# Requirements:
#   sudo apt install gcc-mingw-w64-x86-64
#
# Usage:
#   ./build.sh              # build UberSDRAudio.exe in this directory
#   ./build.sh /some/path   # place the .exe at the given path

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT="${1:-${SCRIPT_DIR}/UberSDRAudio.exe}"

# Check for mingw cross-compiler
if ! command -v x86_64-w64-mingw32-gcc &>/dev/null; then
    echo "ERROR: x86_64-w64-mingw32-gcc not found."
    echo "Install it with:  sudo apt install gcc-mingw-w64-x86-64"
    exit 1
fi

# Check for windres (needed for icon embedding)
if ! command -v x86_64-w64-mingw32-windres &>/dev/null; then
    echo "ERROR: x86_64-w64-mingw32-windres not found."
    echo "Install it with:  sudo apt install gcc-mingw-w64-x86-64"
    exit 1
fi

echo "Building UberSDRAudio.exe for Windows (amd64)..."
echo "Output: ${OUTPUT}"
echo ""

cd "${SCRIPT_DIR}"

# Ensure dependencies are resolved
go mod tidy

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
    -o "${OUTPUT}" \
    .

echo ""
echo "Done: ${OUTPUT}"
ls -lh "${OUTPUT}"
