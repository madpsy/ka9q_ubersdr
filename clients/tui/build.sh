#!/bin/bash
# Cross-compile ubersdr-tui for every supported platform.
#
# This client is deliberately pure Go (no PortAudio, no Opus, no libsamplerate),
# so CGO stays off and every target builds from any host with no cross toolchain,
# sysroot or emulator.

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

  echo "$(du -h "$binary" | cut -f1)"
done

echo
echo -e "${GREEN}Done.${NC} Binaries are in $OUT/:"
ls -1 "$OUT"
