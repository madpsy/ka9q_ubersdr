#!/usr/bin/env bash
# build.sh — Build UberSDRAudio for Linux and cross-compile for Windows
#
# Requirements:
#   sudo apt install gcc-mingw-w64-x86-64 libopus-dev libasound2-dev
#
# Usage:
#   ./build.sh              # build both Linux and Windows binaries
#   ./build.sh /some/path   # place the Windows .exe at the given path
#   ./build.sh --publish    # build, then upload the binaries to the `latest`
#                           # release on GitHub with the gh CLI, replacing the
#                           # ones already there. Asks first.
#   ./build.sh --yes        # answer the publish prompt in advance, for a run
#                           # with nobody at the terminal. Only meaningful with
#                           # --publish.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The publish confirmation, given in advance — see publish_release.
ASSUME_YES=0
PUBLISH=0
OUTPUT_WIN=''

# The release the binaries are uploaded to and every download comes from. A
# rolling tag: publishing moves it, and the asset names are the two filenames
# built below, so the links on the website (index.html, the two download cards)
# never change.
#
# Named here rather than left to gh's guess from `origin`, so a clone with a
# fork as its remote cannot quietly publish this project's downloads somewhere
# else — or, worse, somewhere else's downloads here. Same tag and repo as
# clients/electron/build.sh: one release holds every client.
REPO=madpsy/ka9q_ubersdr
TAG=latest

for arg in "$@"; do
    case "$arg" in
        --publish) PUBLISH=1 ;;
        --yes) ASSUME_YES=1 ;;
        -*) echo "unknown option: $arg" >&2; exit 2 ;;
        *) OUTPUT_WIN="$arg" ;;
    esac
done

OUTPUT_WIN="${OUTPUT_WIN:-${SCRIPT_DIR}/UberSDRAudio.exe}"
OUTPUT_LIN="${SCRIPT_DIR}/UberSDRAudio"

# The names are the contract. gh uploads an asset under its basename, and the
# website links to https://…/releases/download/latest/UberSDRAudio{,.exe}, so an
# .exe built somewhere else under another name would either 404 those links or
# quietly leave the real one stale. Said before the build rather than after it.
if [[ "$PUBLISH" -eq 1 && "$(basename "$OUTPUT_WIN")" != "UberSDRAudio.exe" ]]; then
    echo "--publish uploads $(basename "$OUTPUT_WIN") under that name, and the" >&2
    echo "download links ask for UberSDRAudio.exe. Drop the path, or publish" >&2
    echo "a build made without one." >&2
    exit 2
fi

cd "${SCRIPT_DIR}"

# Uploads the binaries to the rolling release, replacing what is there.
#
# Everything that could stop it is checked and reported rather than left to gh's
# own error: this runs at the end of a build somebody has waited several minutes
# for, and "gh: command not found" scrolling past among the compiler's output is
# a release that quietly did not happen.
#
# Never without being asked. The tag is what every download link points at,
# --clobber replaces the files behind it, and there is no undo — so a terminal
# and a typed yes are the price, and a run with neither declines rather than
# assuming.
publish_release() {
    if ! command -v gh >/dev/null 2>&1; then
        echo "not published: gh not found — install the GitHub CLI, or upload the binaries by hand." >&2
        return
    fi
    if ! gh auth status >/dev/null 2>&1; then
        echo "not published: gh is not logged in — run 'gh auth login'." >&2
        return
    fi
    if ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
        echo "not published: there is no '$TAG' release on $REPO to upload to." >&2
        echo "  create it once with: gh release create $TAG --repo $REPO --title latest --notes ''" >&2
        return
    fi

    # Not every one of these exists after any given build — the Windows half is
    # skipped without mingw — so publishing uploads what is there and says what
    # is not, leaving the rest of the release alone.
    local found=() missing=()
    local asset
    for asset in "$OUTPUT_LIN" "$OUTPUT_WIN"; do
        if [[ -f "$asset" ]]; then found+=("$asset"); else missing+=("$asset"); fi
    done

    if [[ "${#found[@]}" -eq 0 ]]; then
        echo "not published: neither binary was built." >&2
        return
    fi

    echo
    echo "  Upload to https://github.com/$REPO/releases/tag/$TAG, replacing what is there:"
    for asset in "${found[@]}"; do
        echo "      $(basename "$asset")   $(du -h "$asset" | cut -f1)"
    done
    if [[ "${#missing[@]}" -gt 0 ]]; then
        echo
        echo "  Not built here, so left alone on the release:"
        for asset in "${missing[@]}"; do echo "      $(basename "$asset")"; done
    fi
    echo

    # Asked for, one way or the other.
    #
    # The prompt is the default and stays that way: publishing replaces what
    # every download link serves, and a run that reaches this point by accident
    # must not be able to complete it. What `--yes` changes is only *when* the
    # answer was given — typed on the command line rather than at the prompt,
    # which is the same person saying the same thing and is what makes an
    # unattended release possible at all.
    #
    # It is a flag rather than an environment variable on purpose. An exported
    # variable is remembered by a shell and inherited by everything started from
    # it, so a `yes` meant for one release would sit there quietly authorising
    # the next; a flag is spent the moment the command ends.
    if [[ "$ASSUME_YES" -eq 1 ]]; then
        echo "  --yes given; uploading."
    elif [[ ! -t 0 ]]; then
        echo "not published: --publish asks before uploading and there is no terminal to ask on." >&2
        echo "  Pass --yes to answer it in advance." >&2
        return
    else
        local reply=''
        read -r -p "  type 'yes' to upload: " reply || true
        if [[ "$reply" != "yes" ]]; then
            echo "  not published."
            return
        fi
    fi

    # --clobber because the names never change: without it the second release is
    # refused for every asset that already exists.
    if gh release upload "$TAG" "${found[@]}" --clobber --repo "$REPO"; then
        echo "  uploaded to https://github.com/$REPO/releases/tag/$TAG"
    else
        echo "not published: the upload failed — the binaries are intact, try again." >&2
    fi
}

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
# Skipped rather than fatal when the cross-compiler is missing: the Linux half
# is already built and, with --publish, is still worth uploading on its own.
build_windows=1

# Check for mingw cross-compiler
if ! command -v x86_64-w64-mingw32-gcc &>/dev/null; then
    echo "WARNING: x86_64-w64-mingw32-gcc not found — skipping Windows build."
    echo "Install it with:  sudo apt install gcc-mingw-w64-x86-64"
    build_windows=0
fi

# Check for windres (needed for icon embedding)
if [[ "$build_windows" -eq 1 ]] && ! command -v x86_64-w64-mingw32-windres &>/dev/null; then
    echo "WARNING: x86_64-w64-mingw32-windres not found — skipping Windows build."
    echo "Install it with:  sudo apt install gcc-mingw-w64-x86-64"
    build_windows=0
fi

if [[ "$build_windows" -eq 1 ]]; then
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
fi

if [[ "$PUBLISH" -eq 1 ]]; then
    publish_release
fi
