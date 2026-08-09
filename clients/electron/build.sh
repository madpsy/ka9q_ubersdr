#!/usr/bin/env bash
# build.sh — build the v2 frontend and stage it for the desktop client.
#
# The desktop client shares the web UI by consuming its build artifacts, not
# by copying its source: static/v2/build.sh produces dist/, and this script
# stages index.html + dist/ + fonts/ + vendor/ into ui/v2/, which the
# per-instance proxy serves for /v2/* when an instance is set to the built-in
# UI. Nothing under static/v2/ is modified.
#
# Usage:
#   ./build.sh             build v2, stage it, npm-install if needed
#   ./build.sh --skip-ui   skip the v2 build (keep the currently staged UI)
#   ./build.sh --package   all of the above, then produce distributables in dist/:
#                            on Linux   → AppImage + Windows zip
#                            on macOS   → dmg
#                            on Windows → NSIS installer
#                          (a Windows NSIS installer cross-built from Linux needs
#                          wine with 32-bit support, so Linux builds the zip
#                          instead; macOS packages can only be built on a Mac)

set -euo pipefail

cd "$(dirname "$0")"
V2=../../static/v2

SKIP_UI=0
PACKAGE=0
for arg in "$@"; do
    case "$arg" in
        --skip-ui) SKIP_UI=1 ;;
        --package) PACKAGE=1 ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

if [[ "$SKIP_UI" -eq 0 ]]; then
    "$V2/build.sh"

    rm -rf ui
    mkdir -p ui/v2
    cp "$V2/index.html" ui/v2/
    cp -r "$V2/dist" "$V2/fonts" "$V2/vendor" ui/v2/

    # Shown in the chooser footer, so a stale bundle is visible at a glance.
    {
        printf '%s' "$(git -C "$V2" rev-parse --short HEAD 2>/dev/null || echo unknown)"
        printf ' (%s)\n' "$(date -u +%Y-%m-%d)"
    } > ui/BUILD_INFO

    echo "staged v2 UI into ui/v2/ ($(cat ui/BUILD_INFO))"
fi

if [[ ! -d node_modules ]]; then
    command -v npm >/dev/null 2>&1 || { echo "npm not found — install Node.js to run the desktop client" >&2; exit 1; }
    npm install
fi

if [[ "$PACKAGE" -eq 1 ]]; then
    case "$(uname -s)" in
        Linux)  ./node_modules/.bin/electron-builder --linux AppImage --win zip --x64 ;;
        Darwin) ./node_modules/.bin/electron-builder --mac ;;
        *)      ./node_modules/.bin/electron-builder --win nsis ;;
    esac
    echo "distributables in dist/:"
    ls -1sh dist/ | grep -v -- '-unpacked\|builder-\|^total'
fi

echo "done — start with: npm start"
