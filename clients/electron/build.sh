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
#                            on Linux   → AppImage + Windows zip + Windows installer
#                            on macOS   → dmg
#                            on Windows → NSIS installer
#                          (macOS packages can only be built on a Mac)
#   ./build.sh --win-installer
#                          the Windows installer on its own terms: builds it
#                          wherever it can, and fails rather than skipping if it
#                          cannot. `--package` on Linux does it too, but skips
#                          it with a note when Docker is absent.

set -euo pipefail

cd "$(dirname "$0")"
V2=../../static/v2

SKIP_UI=0
PACKAGE=0
WIN_INSTALLER=0
for arg in "$@"; do
    case "$arg" in
        --skip-ui) SKIP_UI=1 ;;
        --package) PACKAGE=1 ;;
        # 2 rather than 1: asked for outright, so a missing Docker is an
        # error here and merely a skipped step when --package implies it.
        --win-installer) WIN_INSTALLER=2; PACKAGE=1 ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

# The Windows installer is built in electron-builder's own image.
#
# NSIS is a Windows toolchain, and cross-building it needs a wine with 32-bit
# support. A wine without one does not fail: it writes a 300 KB stub beside the
# 78 MB payload it failed to embed, and exits 0. An installer that is the wrong
# size by two orders of magnitude and reports success is worse than no
# installer, so this does not attempt it on the host.
#
# The image is electron-builder's own, so the wine in it is the one the tool is
# tested against. The caches are mounted because without them every run
# re-downloads the Windows Electron binaries.
WIN_IMAGE=electronuserland/builder:wine

if [[ "$SKIP_UI" -eq 0 ]]; then
    "$V2/build.sh"

    rm -rf ui
    mkdir -p ui/v2
    cp "$V2/index.html" ui/v2/
    cp -r "$V2/dist" "$V2/fonts" "$V2/vendor" ui/v2/

    # The pages-menu pruning, as CommonJS for the main process: the native
    # Links menu and the UI's own logo menu list the same receiver's pages, so
    # they share the one implementation rather than each keeping a copy that
    # can drift. Same trick the v2 test harness uses to run src modules under
    # plain node.
    esbuild "$V2/src/lib/pagesMenu.js" --bundle --format=cjs --platform=node \
        --log-level=warning --outfile=ui/pagesMenu.cjs

    # The page API's own client library, for the receiver preload: the Layout
    # menu is a bridge client like any browser extension, and hand-rolling the
    # protocol in the preload would be a second implementation of a wire format
    # whose tests are its specification.
    esbuild "$V2/src/bridge/client.js" --bundle --format=cjs --platform=node \
        --log-level=warning --outfile=ui/bridgeClient.cjs

    # ...and then the receiver preload with that client bundled into it.
    #
    # A preload is sandboxed (Electron's default, and worth keeping for a window
    # showing an instance's own pages), and a sandboxed preload's `require` only
    # answers for `electron` — a path to a file of ours fails with "module not
    # found" at runtime. Bundling resolves it at build time instead, which keeps
    # the sandbox rather than trading it for a require.
    esbuild receiver-preload.js --bundle --format=cjs --platform=node \
        --external:electron --log-level=warning --outfile=ui/receiver-preload.js

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
        # This branch already cross-builds for Windows — the zip is a Windows
        # artefact — so the installer belongs with it rather than behind a flag
        # somebody has to know about.
        # An `[[ ]] && x` here would be the last command of the branch, and
        # under `set -e` a false test would end the script.
        Linux)  ./node_modules/.bin/electron-builder --linux AppImage --win zip --x64
                if [[ "$WIN_INSTALLER" -eq 0 ]]; then WIN_INSTALLER=1; fi ;;
        Darwin) ./node_modules/.bin/electron-builder --mac ;;
        # Already on Windows: NSIS builds natively, and Docker would be a
        # detour through a Linux VM to reach the toolchain already present.
        *)      ./node_modules/.bin/electron-builder --win nsis
                WIN_INSTALLER=0 ;;
    esac

    if [[ "$WIN_INSTALLER" -ne 0 ]] && ! command -v docker >/dev/null 2>&1; then
        if [[ "$WIN_INSTALLER" -eq 2 ]]; then
            echo "--win-installer needs docker (the NSIS toolchain runs in $WIN_IMAGE)" >&2
            exit 1
        fi
        # Asked for as part of everything, rather than on its own: the rest of
        # the build is good and the zip is still a usable Windows download, so
        # say what is missing and carry on.
        echo "no docker — skipping the Windows installer (the zip is still built)." >&2
        echo "  install docker, or run ./build.sh --package on Windows itself." >&2
        WIN_INSTALLER=0
    fi

    if [[ "$WIN_INSTALLER" -ne 0 ]]; then
        # `docker run` fetches a missing image on its own, but this one is
        # 4.7 GB and the download would otherwise look like the build hanging.
        if ! docker image inspect "$WIN_IMAGE" >/dev/null 2>&1; then
            echo "fetching $WIN_IMAGE (~4.7 GB, once) …"
            docker pull "$WIN_IMAGE"
        fi
        echo "building the Windows installer in $WIN_IMAGE …"
        mkdir -p "$HOME/.cache/electron" "$HOME/.cache/electron-builder"
        # As you, not as root. The container writes straight into dist/, and
        # root-owned artefacts are ones you cannot delete or overwrite without
        # sudo — including on the next run, which then fails.
        #
        # HOME comes with that: the image's is /root, which is not writable
        # once the user changes, and electron-builder wants somewhere to put a
        # config. /tmp is writable by anyone inside the container, and the two
        # caches worth keeping are mounted from the host explicitly.
        docker run --rm \
            --user "$(id -u):$(id -g)" \
            --env HOME=/tmp/electron-builder-home \
            --env ELECTRON_CACHE="$HOME/.cache/electron" \
            --env ELECTRON_BUILDER_CACHE="$HOME/.cache/electron-builder" \
            -v "$PWD":/project \
            -v "$HOME/.cache/electron":"$HOME/.cache/electron" \
            -v "$HOME/.cache/electron-builder":"$HOME/.cache/electron-builder" \
            -w /project \
            "$WIN_IMAGE" \
            ./node_modules/.bin/electron-builder --win nsis --x64

        # Trust the artefact, not the exit code — see WIN_IMAGE above. The app
        # is over 100 MB, so an installer smaller than 50 MB has not got it.
        setup=$(ls -1 dist/*Setup*.exe 2>/dev/null | head -1 || true)
        if [[ -z "$setup" ]] || [[ $(stat -c%s "$setup") -lt 50000000 ]]; then
            echo "the Windows installer did not build properly — ${setup:-no .exe produced}" >&2
            exit 1
        fi
        # The payload is embedded in the .exe by now; leaving it beside the
        # installer only invites somebody to ship the wrong file.
        rm -f dist/*.nsis.7z
    fi
    echo "distributables in dist/:"
    ls -1sh dist/ | grep -v -- '-unpacked\|builder-\|^total'
fi

echo "done — start with: npm start"
