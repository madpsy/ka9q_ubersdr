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

#
# Usage:
#   ./build.sh                   all eight into build/
#   ./build.sh linux-amd64 …     only the platforms named
#   ./build.sh --publish         ...then upload what this run built to the
#                                `latest` release, replacing what is there.
#                                Asks first. The darwin pair is refused unless
#                                notarise-mac.sh has vouched for it.
#   ./build.sh --yes             answer the publish prompt in advance, for a run
#                                with nobody at the terminal. Only meaningful
#                                with --publish.

set -euo pipefail

cd "$(dirname "$0")"

VERSION="${VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}"
OUT="build"

# The publish confirmation, given in advance — see publish_release.
ASSUME_YES=0
PUBLISH=0

# The release the binaries hang off and every download button fetches from. The
# asset names are the filenames built below, because the buttons at ubersdr.org
# point straight at them, so publishing replaces the assets rather than adding
# new ones. Same tag, repo and override variables as notarise-mac.sh, which
# publishes the other two binaries of the same eight.
REPO="${UBERSDR_REPO:-madpsy/ka9q_ubersdr}"
TAG="${UBERSDR_TAG:-latest}"

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

# Flags first, so what is left is the platform list and the two can be given in
# either order.
WANTED=()
for arg in "$@"; do
  case "$arg" in
    --publish) PUBLISH=1 ;;
    --yes) ASSUME_YES=1 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) WANTED+=("$arg") ;;
  esac
done

# Build only the platforms named on the command line, or all of them.
if [ ${#WANTED[@]} -gt 0 ]; then
  SELECTED=()
  for want in "${WANTED[@]}"; do
    for target in "${TARGETS[@]}"; do
      [ "${target%%:*}" = "$want" ] && SELECTED+=("$target")
    done
  done
  if [ ${#SELECTED[@]} -eq 0 ]; then
    echo "No target matched: ${WANTED[*]}" >&2
    echo "Available: $(printf '%s ' "${TARGETS[@]%%:*}")" >&2
    exit 1
  fi
  TARGETS=("${SELECTED[@]}")
fi

# Uploads what this run built to the rolling release, replacing what is there.
#
# What this run built, and not simply what is in build/: a partial build leaves
# the other binaries there from whenever they were last made, and publishing
# those would put a stale binary on the release under a name that says nothing
# about its age. So `./build.sh linux-amd64 --publish` uploads one file.
#
# Everything that could stop it is checked and reported rather than left to gh's
# own error: this runs at the end of a build, and "gh: command not found"
# scrolling past is a release that quietly did not happen.
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

  # A macOS binary nobody else can run is worse than no macOS binary.
  #
  # Gatekeeper kills an unsigned *downloaded* executable with `zsh: killed` and
  # no explanation, so only a binary Apple has accepted may go up — and the only
  # thing that knows Apple accepted it is the .gatekeeper-ok marker
  # notarise-mac.sh writes beside the exact file it signed. The build above
  # deletes that marker whenever it rebuilds a target, so a fresh darwin binary
  # never has one and is held back here rather than shipped unsigned.
  local uploads=() unsigned=()
  local target name binary
  for target in "${TARGETS[@]}"; do
    name="${target%%:*}"
    binary="$OUT/ubersdr-tui-$name"
    case "$name" in windows-*) binary="$binary.exe" ;; esac
    [ -f "$binary" ] || continue
    case "$name" in
      darwin-*)
        if [ -f "$binary.gatekeeper-ok" ]; then uploads+=("$binary"); else unsigned+=("$binary"); fi ;;
      *) uploads+=("$binary") ;;
    esac
  done

  if [ ${#unsigned[@]} -gt 0 ]; then
    echo
    echo "  Not uploading — signed and notarised is not optional on macOS:"
    for binary in "${unsigned[@]}"; do
      echo "      $(basename "$binary")   no $(basename "$binary").gatekeeper-ok"
    done
    echo "  ./notarise-mac.sh --publish signs them on the Mac and uploads them."
    echo
  fi

  if [ ${#uploads[@]} -eq 0 ]; then
    echo "not published: this run produced nothing that may be uploaded." >&2
    return
  fi

  echo "  Upload to https://github.com/$REPO/releases/tag/$TAG, replacing what is there:"
  for binary in "${uploads[@]}"; do
    echo "      $(basename "$binary")   $(du -h "$binary" | cut -f1)"
  done
  echo

  # Asked for, one way or the other.
  #
  # The prompt is the default and stays that way: publishing replaces what every
  # download button serves, and a run that reaches this point by accident must
  # not be able to complete it. `--yes` changes only *when* the answer was given
  # — on the command line rather than at the prompt, which is the same person
  # saying the same thing and is what makes an unattended release possible.
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
#
# Skipped when publishing, which says the same thing about the same binaries at
# the point it declines to upload them.
if [ "$PUBLISH" -eq 0 ]; then
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
fi

if [ "$PUBLISH" -eq 1 ]; then
  echo
  publish_release
fi
