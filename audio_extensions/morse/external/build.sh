#!/usr/bin/env bash
# build.sh — build cw-decoder for amd64 and arm64, and publish.
#
# Each architecture builds in an ubuntu:24.04 container of that architecture
# (arm64 under the qemu binfmt handler). That is the base of docker/Dockerfile,
# which downloads these binaries from the `latest` release, so the glibc and
# libstdc++ they link against are the ones they will run on. A build on the
# host would pick up whatever the developer's distro has.
#
# Usage:
#   ./build.sh                 both architectures into dist/
#   ./build.sh amd64           just the one — amd64 or arm64
#   ./build.sh --publish       ...then upload what this run built to the `latest`
#                              release, replacing what is there. Asks first.
#   ./build.sh --yes           answer the publish prompt in advance. Only with
#                              --publish.
#   ./build.sh --clean         remove dist/ and build-docker/ first
#
# Requires docker. For arm64 the qemu handlers must be registered:
#   docker run --privileged --rm tonistiigi/binfmt --install arm64
#
# Docker images pick up a new binary only when they are rebuilt: the download
# happens at image build time.

set -euo pipefail

cd "$(dirname "$0")"

BINARY="cw-decoder"
OUT="dist"
WORK="build-docker"
BASE_IMAGE="ubuntu:24.04"

REPO="${UBERSDR_REPO:-madpsy/ka9q_ubersdr}"
TAG="${UBERSDR_TAG:-latest}"

PUBLISH=0
ASSUME_YES=0
CLEAN=0

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

ALL_TARGETS=("amd64:linux/amd64" "arm64:linux/arm64")
TARGETS=()

BUILD_CONTAINER=""
cleanup() {
  local status=$?
  if [ -n "$BUILD_CONTAINER" ] && docker ps -q --filter "name=^${BUILD_CONTAINER}$" 2>/dev/null | grep -q .; then
    echo "  stopping build container $BUILD_CONTAINER" >&2
    docker kill "$BUILD_CONTAINER" >/dev/null 2>&1 || true
  fi
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

if ! docker info >/dev/null 2>&1; then
  echo -e "${RED}docker is needed and not usable — is it installed, the daemon running, and are you in the docker group?${NC}" >&2
  exit 1
fi

[ "$CLEAN" -eq 1 ] && { echo "Cleaning $OUT/ and $WORK/"; rm -rf "$OUT" "$WORK"; }

build_one() {
  local arch="$1" platform="$2"
  local asset="$OUT/${BINARY}_${arch}"
  local image="ubersdr-cw-decoder-build:$arch"
  local log="build_${arch}.log"
  echo -ne "${YELLOW}  $arch${NC} … "

  # The toolchain goes in an image rather than being apt-installed per run:
  # docker caches the layer, and the build container can then run as the
  # calling user so dist/ is not left owned by root.
  if ! docker build --quiet --platform "$platform" -t "$image" - >"$log" 2>&1 <<EOF
FROM $BASE_IMAGE
RUN apt-get update && apt-get install -y --no-install-recommends cmake ninja-build g++ && rm -rf /var/lib/apt/lists/*
EOF
  then
    echo -e "${RED}toolchain image failed${NC}"
    tail -15 "$log" >&2
    return 1
  fi

  BUILD_CONTAINER="ubersdr-cw-decoder-build-$$-$arch"
  docker run --rm --name "$BUILD_CONTAINER" --platform "$platform" \
      --user "$(id -u):$(id -g)" -e HOME=/tmp \
      -v "$PWD:/src" -w /src "$image" \
      sh -c "
        set -e
        cmake -S . -B $WORK/$arch -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo
        cmake --build $WORK/$arch
        mkdir -p $OUT
        cp $WORK/$arch/$BINARY $asset
      " >>"$log" 2>&1 &
  local pid=$!
  if ! wait "$pid"; then
    echo -e "${RED}failed${NC}"
    tail -15 "$log" >&2
    return 1
  fi
  BUILD_CONTAINER=""
  rm -f "$log"

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
    return 1
  fi
  if ! gh auth status >/dev/null 2>&1; then
    echo "not published: gh is not logged in — run 'gh auth login'." >&2
    return 1
  fi
  if ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
    echo "not published: there is no '$TAG' release on $REPO to upload to." >&2
    return 1
  fi

  # Only what this run built: a single-arch run leaves the other one in dist/
  # from whenever it was last made.
  local uploads=() t asset
  for t in "${TARGETS[@]}"; do
    asset="$OUT/${BINARY}_${t%%:*}"
    [ -f "$asset" ] && uploads+=("$asset")
  done
  if [ ${#uploads[@]} -eq 0 ]; then
    echo "not published: this run produced nothing to upload." >&2
    return 1
  fi

  echo "  Upload to https://github.com/$REPO/releases/tag/$TAG, replacing what is there:"
  for asset in "${uploads[@]}"; do
    echo "      $(basename "$asset")   $(du -h --apparent-size "$asset" | cut -f1)"
  done
  echo

  if [ "$ASSUME_YES" -eq 1 ]; then
    echo "  --yes given; uploading."
  elif [ ! -t 0 ]; then
    echo "not published: --publish asks before uploading and there is no terminal to ask on. Pass --yes." >&2
    return 1
  else
    local reply=''
    read -r -p "  type 'yes' to upload: " reply || true
    [ "$reply" = "yes" ] || { echo "  not published."; return 0; }
  fi

  if gh release upload "$TAG" "${uploads[@]}" --clobber --repo "$REPO"; then
    echo "  uploaded to https://github.com/$REPO/releases/tag/$TAG"
  else
    echo "not published: the upload failed — $OUT/ is intact, try again." >&2
    return 1
  fi
}

echo -e "${GREEN}Building $BINARY ($BASE_IMAGE)${NC}"
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
