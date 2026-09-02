#!/usr/bin/env bash
# build.sh — build iq-recorder for amd64 and arm64, and publish them.
#
# Pure Go with nothing to link against — the dependencies are gorilla/websocket
# and google/uuid, and the version 4 decoder that replaced the zstd one is
# stdlib only — so CGO stays off and both architectures cross-compile from any
# host with no container, no cross toolchain and no emulator. That is why this
# is 100 lines where clients/rtl_sdr/build.sh is 450: that bridge needs cgo for
# nss-mdns, and everything it does with docker and qemu follows from that.
#
# The one thing CGO_ENABLED=0 costs is the same one, and it is worth stating
# rather than discovering: a static binary uses Go's own resolver, which reads
# /etc/hosts and speaks DNS but cannot call NSS modules. So `-host ubersdr.local`
# will not resolve through nss-mdns here, while a hostname, an address and
# localhost all do. Recording is aimed at a named receiver rather than a
# discovered one, and the alternative is rtl_sdr's container build, so this is
# the right trade for this client -- but it is a trade.
#
# Usage:
#   ./build.sh                 both architectures into build/
#   ./build.sh amd64           just the one — amd64 or arm64
#   ./build.sh --test          run the tests before building
#   ./build.sh --publish       ...then upload what this run built to the `latest`
#                              release, replacing what is there. Asks first.
#   ./build.sh --yes           answer the publish prompt in advance, for a run
#                              with nobody at the terminal. Only meaningful with
#                              --publish.

set -euo pipefail

cd "$(dirname "$0")"

BINARY="iq-recorder"
OUT="build"
VERSION="${VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}"

# The release the binaries hang off. The asset names are the filenames built
# below, so publishing replaces an asset rather than adding a new one. Same tag,
# repo and override variables as the other clients' build scripts.
#
# The `iq_recorder` and `iq_recorder.exe` already on that release are the PYTHON
# recorder from clients/python_iq_recorder, which is a different program with a
# GUI. The underscore is what keeps the two apart, so do not "tidy" this name to
# match it: that would overwrite the Python build with this one.
REPO="${UBERSDR_REPO:-madpsy/ka9q_ubersdr}"
TAG="${UBERSDR_TAG:-latest}"

RUN_TESTS=0
PUBLISH=0
ASSUME_YES=0

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# arch:GOARCH — linux only, which is what a recorder left running somewhere is.
TARGETS=(
  "amd64:amd64"
  "arm64:arm64"
)

# Flags first, so what is left is the architecture list and the two can be given
# in either order.
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
# the other binary there from whenever it was last made, and publishing that
# would put a stale binary on the release under a name that says nothing about
# its age. So `./build.sh amd64 --publish` uploads one file.
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

  local uploads=() target name asset
  for target in "${TARGETS[@]}"; do
    name="${target%%:*}"
    asset="$OUT/${BINARY}_$name"
    [ -f "$asset" ] && uploads+=("$asset")
  done

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

# Before building, not after: the version 4 decoder is checked against a stream
# the server's encoder produced, and a predictor that has drifted returns
# plausible noise rather than an error. Publishing that is worse than not
# publishing at all, so a failure here stops the run.
if [ "$RUN_TESTS" -eq 1 ]; then
  echo -e "${GREEN}Testing${NC}"
  go test ./...
  echo
fi

echo -e "${GREEN}Building $BINARY ${VERSION}${NC}"
mkdir -p "$OUT"

for target in "${TARGETS[@]}"; do
  IFS=: read -r name goarch <<<"$target"

  asset="$OUT/${BINARY}_$name"
  echo -ne "${YELLOW}  $name${NC} … "

  # -trimpath keeps absolute build paths out of the binary; -s -w drop the
  # symbol table and DWARF data, roughly halving the size.
  env CGO_ENABLED=0 GOOS=linux GOARCH="$goarch" \
    go build -trimpath -ldflags "-s -w" -o "$asset" .

  echo "$(du -h --apparent-size "$asset" | cut -f1)"
done

echo
echo -e "${GREEN}Done.${NC} Binaries are in $OUT/:"
ls -1 "$OUT"

if [ "$PUBLISH" -eq 1 ]; then
  echo
  publish_release
fi
