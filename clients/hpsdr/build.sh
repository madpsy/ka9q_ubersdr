#!/usr/bin/env bash
# build.sh — build the HPSDR bridge binary
# Usage:
#   ./build.sh            # build to ./hpsdr-bridge
#   ./build.sh -race      # build with race detector
#   ./build.sh -v         # verbose build output
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

OUTPUT="${OUTPUT:-./hpsdr-bridge}"
EXTRA_FLAGS=()

for arg in "$@"; do
    case "$arg" in
        -race) EXTRA_FLAGS+=("-race") ;;
        -v)    EXTRA_FLAGS+=("-v") ;;
        *)     echo "Unknown flag: $arg" >&2; exit 1 ;;
    esac
done

echo "Building HPSDR bridge → $OUTPUT"
go build "${EXTRA_FLAGS[@]}" -o "$OUTPUT" .
echo "Done: $OUTPUT"
