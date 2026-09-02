#!/usr/bin/env bash
# build.sh — build the UberSDR benchmark tool for amd64 and arm64, and publish.
#
# PyInstaller cannot cross-compile: it bundles the interpreter and the native
# extension modules of whatever it runs on. So each architecture is built inside
# a container of that architecture -- amd64 natively, arm64 under the qemu
# binfmt handler -- rather than by passing a target flag.
#
# Containers for both rather than a venv for the host and a container for the
# other: one Python version and one glibc build both binaries, so the two differ
# only in architecture. Building amd64 from whatever python3 happens to be on
# the developer's machine would make the published pair inconsistent.
#
# Usage:
#   ./build.sh                 both architectures into dist/
#   ./build.sh amd64           just the one — amd64 or arm64
#   ./build.sh --publish       ...then upload what this run built to the `latest`
#                              release, replacing what is there. Asks first.
#   ./build.sh --yes           answer the publish prompt in advance, for a run
#                              with nobody at the terminal. Only with --publish.
#   ./build.sh --clean         remove dist/ and build/ first
#
# Requires docker. For arm64 the qemu handlers must be registered; the build
# reports it if they are not, and `docker run --privileged --rm tonistiigi/binfmt
# --install arm64` installs them.

set -euo pipefail

cd "$(dirname "$0")"

BINARY="benchmark"
OUT="dist"
# The full image rather than -slim: PyInstaller needs objdump on Linux, which
# comes from binutils and is not in slim. Installing it per build would need root
# in a container deliberately run as the calling user, so the image supplies it.
IMAGE="${UBERSDR_PY_IMAGE:-python:3.12}"

REPO="${UBERSDR_REPO:-madpsy/ka9q_ubersdr}"
TAG="${UBERSDR_TAG:-latest}"

PUBLISH=0
ASSUME_YES=0
CLEAN=0

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# arch:docker platform
ALL_TARGETS=("amd64:linux/amd64" "arm64:linux/arm64")
TARGETS=()

# What an interrupt has to take with it. The container is not a child of this
# shell, so killing the script would otherwise leave it building.
BUILD_CONTAINER=""
cleanup() {
  local status=$?
  if [ -n "$BUILD_CONTAINER" ] && docker ps -q --filter "name=^${BUILD_CONTAINER}$" 2>/dev/null | grep -q .; then
    echo "  stopping build container $BUILD_CONTAINER" >&2
    docker kill "$BUILD_CONTAINER" >/dev/null 2>&1 || true
  fi
  BUILD_CONTAINER=""
  return $status
}
trap cleanup EXIT INT TERM

WANTED=()
for arg in "$@"; do
  case "$arg" in
    --publish) PUBLISH=1 ;;
    --yes) ASSUME_YES=1 ;;
    --clean) CLEAN=1 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    amd64|arm64) WANTED+=("$arg") ;;
    *) echo "unknown target: $arg (expected amd64 or arm64)" >&2; exit 2 ;;
  esac
done
if [ ${#WANTED[@]} -gt 0 ]; then
  for want in "${WANTED[@]}"; do
    for t in "${ALL_TARGETS[@]}"; do
      [ "${t%%:*}" = "$want" ] && TARGETS+=("$t")
    done
  done
else
  TARGETS=("${ALL_TARGETS[@]}")
fi

if ! command -v docker >/dev/null 2>&1; then
  echo -e "${RED}docker is needed: PyInstaller cannot cross-compile, so each architecture builds in a container of its own.${NC}" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo -e "${RED}docker is installed but not usable — is the daemon running, and are you in the docker group?${NC}" >&2
  exit 1
fi

[ "$CLEAN" -eq 1 ] && { echo "Cleaning dist/ and build/"; rm -rf dist build; }

build_one() {
  local arch="$1" platform="$2"
  local asset="$OUT/${BINARY}_${arch}"
  echo -ne "${YELLOW}  $arch${NC} … "

  BUILD_CONTAINER="ubersdr-benchmark-build-$$-$arch"

  # --user keeps dist/ and build/ owned by whoever ran this, rather than root.
  # Without it the next run cannot clean its own output.
  docker run --rm --name "$BUILD_CONTAINER" --platform "$platform" \
      --user "$(id -u):$(id -g)" \
      -e HOME=/tmp -e PYTHONDONTWRITEBYTECODE=1 \
      -v "$PWD:/src" -w /src "$IMAGE" \
      sh -c "
        set -e
        pip install --quiet --no-warn-script-location -r requirements.txt pyinstaller
        python -m PyInstaller --onefile --name ${BINARY}_${arch} \
          --distpath $OUT --workpath build/$arch --specpath build/$arch \
          --clean --noconfirm benchmark.py
      " >"build_${arch}.log" 2>&1 &
  local pid=$!
  # Backgrounded and waited on so a signal is serviced now rather than after the
  # build it is meant to cancel has finished on its own.
  if ! wait "$pid"; then
    echo -e "${RED}failed${NC}"
    tail -15 "build_${arch}.log" >&2
    return 1
  fi
  BUILD_CONTAINER=""
  rm -f "build_${arch}.log"

  if [ ! -f "$asset" ]; then
    echo -e "${RED}produced no $asset${NC}" >&2
    return 1
  fi
  # A binary of the wrong architecture means the platform flag was ignored --
  # which produces a correctly named file that will not run on the machine it
  # is published for.
  local want_machine="x86-64"; [ "$arch" = "arm64" ] && want_machine="aarch64"
  if ! file "$asset" | grep -qi "$want_machine"; then
    echo -e "${RED}wrong architecture:${NC} $(file -b "$asset")" >&2
    rm -f "$asset"
    return 1
  fi
  echo "$(du -h "$asset" | cut -f1)"
}

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

  # What this run built, not simply what is in dist/: a partial build leaves the
  # other architecture there from whenever it was last made, and publishing that
  # puts a stale binary on the release under a name that says nothing about its
  # age.
  local uploads=() t asset
  for t in "${TARGETS[@]}"; do
    asset="$OUT/${BINARY}_${t%%:*}"
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

  # The prompt is the default and stays that way: publishing replaces what every
  # download link serves. `--yes` changes only when the answer was given, not
  # whether one was needed -- and it is a flag rather than an environment
  # variable so a `yes` meant for one release cannot authorise the next.
  if [ "$ASSUME_YES" -eq 1 ]; then
    echo "  --yes given; uploading."
  elif [ ! -t 0 ]; then
    echo "not published: --publish asks before uploading and there is no terminal to ask on." >&2
    echo "  Pass --yes to answer it in advance." >&2
    return
  else
    local reply=''
    read -r -p "  type 'yes' to upload: " reply || true
    [ "$reply" = "yes" ] || { echo "  not published."; return; }
  fi

  # --clobber because the asset names are constants.
  if gh release upload "$TAG" "${uploads[@]}" --clobber --repo "$REPO"; then
    echo "  uploaded to https://github.com/$REPO/releases/tag/$TAG"
  else
    echo "not published: the upload failed — $OUT/ is intact, try again." >&2
  fi
}

echo -e "${GREEN}Building $BINARY ($IMAGE)${NC}"
mkdir -p "$OUT"
for t in "${TARGETS[@]}"; do
  build_one "${t%%:*}" "${t#*:}"
done

echo
echo -e "${GREEN}Done.${NC} Binaries are in $OUT/:"
ls -1 "$OUT"

if [ "$PUBLISH" -eq 1 ]; then
  echo
  publish_release
fi
