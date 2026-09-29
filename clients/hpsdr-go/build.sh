#!/usr/bin/env bash
# build.sh — build ubersdr-hpsdr for Windows, macOS and Linux, and publish it.
#
# Pure Go, CGO off: the WebSocket, the version 4 decoder, the HPSDR protocols and
# the TUI (tview on tcell) are all Go, so every target cross-compiles from any
# host with no container, cross toolchain or emulator. That is the reason this
# port exists -- the C bridge in clients/hpsdr links libwebsockets and builds for
# Linux only, in a target-architecture container per arch.
#
# The darwin pair is not finished when this script ends. Gatekeeper kills a
# *downloaded* macOS binary that is not signed with a Developer ID certificate
# and notarised by Apple, so those two go through ./notarise-mac.sh, on a Mac,
# before they are published -- as clients/tui's do.
#
# The one thing CGO_ENABLED=0 costs is name resolution through NSS: Go's own
# resolver reads /etc/hosts and speaks DNS, so a receiver named by an
# nss-mdns ".local" name will not resolve. The TUI's own mDNS browse finds LAN
# receivers and uses their addresses, which is the case that matters.
#
# Usage:
#   ./build.sh                 every target into build/
#   ./build.sh linux_arm64     just the ones named (see TARGETS)
#   ./build.sh --test          run the tests before building
#   ./build.sh --publish       ...then upload what this run built to the `latest`
#                              release, replacing what is there. Asks first. The
#                              darwin pair is refused unless notarise-mac.sh has
#                              vouched for it.
#   ./build.sh --yes           answer the publish prompt in advance.

set -euo pipefail

cd "$(dirname "$0")"

BINARY="ubersdr-hpsdr"
OUT="build"
VERSION="${VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}"

# Same tag, repo and override variables as the other clients' build scripts.
# The asset names are the filenames built below, so publishing replaces an asset
# rather than adding one. They are distinct from the C bridge's
# ubersdr-hpsdr-bridge_{amd64,arm64}, which stay as they are.
REPO="${UBERSDR_REPO:-madpsy/ka9q_ubersdr}"
TAG="${UBERSDR_TAG:-latest}"

RUN_TESTS=0
PUBLISH=0
ASSUME_YES=0

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# GOOS_GOARCH. linux_arm is 32-bit Raspberry Pi OS (ARMv7).
TARGETS=(
  linux_amd64
  linux_arm64
  linux_arm
  windows_amd64
  windows_arm64
  darwin_amd64
  darwin_arm64
)

asset_name() {
  local t="$1"
  case "$t" in
    windows_*) echo "${BINARY}_${t}.exe" ;;
    *) echo "${BINARY}_${t}" ;;
  esac
}

WANTED=()
for arg in "$@"; do
  case "$arg" in
    --test) RUN_TESTS=1 ;;
    --publish) PUBLISH=1 ;;
    --yes) ASSUME_YES=1 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) WANTED+=("$arg") ;;
  esac
done

if [ ${#WANTED[@]} -gt 0 ]; then
  SELECTED=()
  for want in "${WANTED[@]}"; do
    for target in "${TARGETS[@]}"; do
      [ "$target" = "$want" ] && SELECTED+=("$target")
    done
  done
  if [ ${#SELECTED[@]} -eq 0 ]; then
    echo "No target matched: ${WANTED[*]}" >&2
    echo "Available: ${TARGETS[*]}" >&2
    exit 1
  fi
  TARGETS=("${SELECTED[@]}")
fi

# Uploads what this run built to the rolling release, replacing what is there.
# Only what THIS run built: a partial build leaves older binaries in build/, and
# publishing those would put stale files on the release under current names.
publish_release() {
  if ! command -v gh >/dev/null 2>&1; then
    echo "not published: gh not found — install the GitHub CLI, or upload $OUT/ by hand." >&2
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

  # A macOS binary nobody else can run is worse than none: only one with the
  # .gatekeeper-ok marker notarise-mac.sh writes beside the file it signed may
  # go up, and a rebuild deletes that marker.
  local uploads=() unsigned=() target asset
  for target in "${TARGETS[@]}"; do
    asset="$OUT/$(asset_name "$target")"
    [ -f "$asset" ] || continue
    case "$target" in
      darwin_*)
        if [ -f "$asset.gatekeeper-ok" ]; then uploads+=("$asset"); else unsigned+=("$asset"); fi ;;
      *) uploads+=("$asset") ;;
    esac
  done

  if [ ${#unsigned[@]} -gt 0 ]; then
    echo
    echo "  Not uploading — signed and notarised is not optional on macOS:"
    for asset in "${unsigned[@]}"; do
      echo "      $(basename "$asset")   no $(basename "$asset").gatekeeper-ok"
    done
    echo "  ./notarise-mac.sh --publish signs them on the Mac and uploads them."
    echo
  fi

  if [ ${#uploads[@]} -eq 0 ]; then
    echo "not published: this run produced nothing to upload." >&2
    return
  fi

  echo "  Upload to https://github.com/$REPO/releases/tag/$TAG, replacing what is there:"
  for asset in "${uploads[@]}"; do
    echo "      $(basename "$asset")   $(du -h --apparent-size "$asset" | cut -f1)"
  done
  echo

  # Asked for, one way or the other.
  #
  # The prompt is the default and stays that way: publishing replaces what every
  # download link serves, and a run that reaches this point by accident must not
  # be able to complete it. `--yes` changes only *when* the answer was given — on
  # the command line rather than at the prompt, which is the same person saying
  # the same thing and is what makes an unattended release possible.
  #
  # A flag rather than an environment variable on purpose: an exported variable
  # is inherited by everything a shell starts, so a `yes` meant for one release
  # would sit there quietly authorising the next.
  if [ "$ASSUME_YES" -eq 1 ]; then
    echo "  --yes given; uploading."
  elif [ ! -t 0 ]; then
    echo "not published: --publish asks before uploading and there is no terminal to ask on." >&2
    echo "  Pass --yes to answer it in advance." >&2
    return
  else
    local reply=''
    read -r -p "  type 'yes' to upload: " reply || true
    if [ "$reply" != "yes" ]; then
      echo "  not published."
      return
    fi
  fi

  # --clobber because the asset names are constants: without it the second
  # release is refused for every name that already exists.
  if gh release upload "$TAG" "${uploads[@]}" --clobber --repo "$REPO"; then
    echo "  uploaded to https://github.com/$REPO/releases/tag/$TAG"
  else
    echo "not published: the upload failed — $OUT/ is intact, try again." >&2
  fi
}

# Before building: the decoder is checked against streams the server's encoder
# produced and the protocols byte by byte, and a failure here stops the run.
# -short skips the one test that waits out the 3 s protocol 1 watchdog.
if [ "$RUN_TESTS" -eq 1 ]; then
  echo -e "${GREEN}Testing${NC}"
  go test -short ./...
  echo
fi

echo -e "${GREEN}Building $BINARY ${VERSION}${NC}"
mkdir -p "$OUT"

for target in "${TARGETS[@]}"; do
  goos="${target%%_*}"
  goarch="${target#*_}"
  asset="$OUT/$(asset_name "$target")"
  echo -ne "${YELLOW}  $target${NC} … "
  # -trimpath keeps build paths out of the binary; -s -w drop the symbol table
  # and DWARF, roughly halving the size. GOARM=7 for linux_arm: every Pi that
  # runs a 32-bit OS today is ARMv7 or later.
  env CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" GOARM=7 \
    go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o "$asset" .
  # A fresh binary is not the notarised one, whatever is written beside it.
  rm -f "$asset.gatekeeper-ok"
  echo "$(du -h --apparent-size "$asset" | cut -f1)"
done

echo
echo -e "${GREEN}Done.${NC} Binaries are in $OUT/:"
ls -1 "$OUT"

# Said on every build that touched darwin: a rebuilt binary has lost its
# signature, and otherwise the way to find out is a macOS user reporting that
# the download does not run.
if [ "$PUBLISH" -eq 0 ]; then
  for target in "${TARGETS[@]}"; do
    case "$target" in darwin_*)
      echo
      echo "  The darwin binaries are unsigned as they stand, and Gatekeeper kills"
      echo "  an unsigned download on somebody else's Mac. Before publishing them:"
      echo "      ./notarise-mac.sh            sign, notarise and verify"
      echo "      ./notarise-mac.sh --publish  ...and upload them to the release"
      break ;;
    esac
  done
fi

if [ "$PUBLISH" -eq 1 ]; then
  echo
  publish_release
fi
