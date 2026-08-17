#!/bin/bash
# Cross-compile ubersdr-tui for every supported platform.
#
# This client is deliberately pure Go (no PortAudio, no Opus, no libsamplerate),
# so CGO stays off and every target builds from any host with no cross toolchain,
# sysroot or emulator.
#
# The darwin pair is not finished when this script ends. Gatekeeper kills a
# *downloaded* macOS binary that is not signed with a Developer ID certificate
# and notarised by Apple — exit 137, with no explanation to the person who
# downloaded it — so those two go through ./notarise-mac.sh before they are
# published. That needs a Mac, which is why it is a separate script and why this
# one still builds them here: the build is pure cross-compilation, and only the
# signing needs the other machine. See the Releasing section of README.md.

set -euo pipefail

cd "$(dirname "$0")"

VERSION="${VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}"
OUT="build"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# platform:GOOS:GOARCH:GOARM (GOARM blank where it does not apply)
TARGETS=(
  "linux-amd64:linux:amd64:"
  "linux-arm64:linux:arm64:"
  "linux-armv7:linux:arm:7"
  "linux-armv6:linux:arm:6"
  "darwin-amd64:darwin:amd64:"
  "darwin-arm64:darwin:arm64:"
  "windows-amd64:windows:amd64:"
  "windows-arm64:windows:arm64:"
)

# Build only the platforms named on the command line, or all of them.
if [ $# -gt 0 ]; then
  SELECTED=()
  for want in "$@"; do
    for target in "${TARGETS[@]}"; do
      [ "${target%%:*}" = "$want" ] && SELECTED+=("$target")
    done
  done
  if [ ${#SELECTED[@]} -eq 0 ]; then
    echo "No target matched: $*" >&2
    echo "Available: $(printf '%s ' "${TARGETS[@]%%:*}")" >&2
    exit 1
  fi
  TARGETS=("${SELECTED[@]}")
fi

echo -e "${GREEN}Building ubersdr-tui ${VERSION}${NC}"
mkdir -p "$OUT"

for target in "${TARGETS[@]}"; do
  IFS=: read -r name goos goarch goarm <<<"$target"

  binary="$OUT/ubersdr-tui-$name"
  [ "$goos" = "windows" ] && binary="$binary.exe"

  echo -ne "${YELLOW}  $name${NC} … "

  # -trimpath keeps absolute build paths out of the binary; -s -w drop the
  # symbol table and DWARF data, roughly halving the size.
  env CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" GOARM="$goarm" \
    go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o "$binary" .

  # A fresh binary is not the notarised one, whatever is written beside it.
  # notarise-mac.sh leaves a .gatekeeper-ok marker recording Apple's verdict on
  # the exact file it signed, and a rebuild replaces that file — so the marker
  # goes with it rather than being left to vouch for a binary Apple never saw.
  rm -f "$binary.gatekeeper-ok"

  echo "$(du -h "$binary" | cut -f1)"
done

echo
echo -e "${GREEN}Done.${NC} Binaries are in $OUT/:"
ls -1 "$OUT"

# Said here because nothing else will say it, and the way to find out otherwise
# is a macOS user reporting that the download does not run. A signed binary that
# was rebuilt has lost its signature along with everything else, so this is worth
# repeating on every build that touched darwin — not only on the first.
for target in "${TARGETS[@]}"; do
  case "${target%%:*}" in darwin-*)
    echo
    echo "  The darwin binaries are unsigned as they stand, and Gatekeeper kills"
    echo "  an unsigned download on somebody else's Mac. Before publishing them:"
    echo "      ./notarise-mac.sh            sign, notarise and verify"
    echo "      ./notarise-mac.sh --publish  ...and upload them to the release"
    break ;;
  esac
done
