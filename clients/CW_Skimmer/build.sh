#!/usr/bin/env bash
# build.sh — cross-build UberSDRIntf.dll and UberSDRMonitor.exe, and package them.
#
# Both are Windows binaries and neither needs Visual Studio: mingw-w64 in a
# container builds them from Linux, which is what makes them reproducible here
# rather than only on somebody's desktop.
#
# The two are deliberately different architectures, and that is not an oversight:
#
#   UberSDRIntf.dll     32-bit — CW Skimmer Server is a 32-bit process and loads
#                       the DLL into it, so it has no choice.
#   UberSDRMonitor.exe  64-bit — a standalone status window that reaches the DLL
#                       through shared memory, which works across bitness.
#
# That split makes UberSDRShared.h a cross-bitness contract. It holds only
# fixed-width and layout-stable types today (int, int64_t, float, char[], bool,
# DWORD) and both targets agree on every size; adding a pointer or a size_t to
# it would silently desynchronise the monitor from the DLL, with no error from
# either side.
#
# Three things the MSVC build tolerates and this one does not, all fixed in the
# sources rather than papered over here: a missing <cmath> for cos/sin, the
# rpcrt4 import library for UuidCreate, and a block-scope `extern` that named
# UberSDRIntf::ProcessIQData where the definition is at global scope.
#
# The default mingw alternative on Debian is the win32 threading model, which
# has no std::mutex or std::thread. IXWebSocket needs both, so the posix variant
# is selected explicitly.
#
# Usage:
#   ./build.sh                 build both, into dist/
#   ./build.sh dll             just the one — dll or monitor
#   ./build.sh --zip           ...and package dist/CW_Skimmer.zip
#   ./build.sh --zip-to DIR    write the zip somewhere else
#   ./build.sh --publish       ...then upload the zip to the `latest` release,
#                              replacing what is there. Implies --zip. Asks first.
#   ./build.sh --yes           answer the publish prompt in advance, for a run
#                              with nobody at the terminal. Only with --publish.
#   ./build.sh --clean         remove dist/ first

set -euo pipefail
cd "$(dirname "$0")"

IMAGE="${UBERSDR_MINGW_IMAGE:-debian:bookworm}"
OUT="dist"
ZIP_DIR=""
DO_ZIP=0
DO_PUBLISH=0
ASSUME_YES=0
CLEAN=0
TARGETS=()

REPO="${UBERSDR_REPO:-madpsy/ka9q_ubersdr}"
TAG="${UBERSDR_TAG:-latest}"
ASSET="CW_Skimmer.zip"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

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

while [ $# -gt 0 ]; do
  case "$1" in
    --zip) DO_ZIP=1 ;;
    --zip-to) DO_ZIP=1; ZIP_DIR="$2"; shift ;;
    --publish) DO_PUBLISH=1; DO_ZIP=1 ;;
    --yes) ASSUME_YES=1 ;;
    --clean) CLEAN=1 ;;
    dll|monitor) TARGETS+=("$1") ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) echo "unknown target: $1 (expected dll or monitor)" >&2; exit 2 ;;
  esac
  shift
done
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=(dll monitor)

want() { local t; for t in "${TARGETS[@]}"; do [ "$t" = "$1" ] && return 0; done; return 1; }

command -v docker >/dev/null 2>&1 || { echo -e "${RED}docker is required${NC}" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo -e "${RED}docker is not usable — daemon running? in the docker group?${NC}" >&2; exit 1; }

[ "$CLEAN" -eq 1 ] && rm -rf "$OUT"
mkdir -p "$OUT"

BUILD_CONTAINER="ubersdr-cwskimmer-build-$$"
echo -e "${GREEN}Building CW Skimmer plugin ($IMAGE, mingw-w64)${NC}"

# Root inside, because installing the toolchain needs it; build-inside.sh hands
# ownership of everything it wrote back before it exits, so dist/ does not come
# out root-owned and unremovable by the next run.
docker run --rm --name "$BUILD_CONTAINER" \
    -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
    -v "$PWD:/w" -w /w "$IMAGE" \
    bash /w/build-inside.sh "${TARGETS[*]}" >"$OUT/build.log" 2>&1 &
docker_pid=$!
# Backgrounded and waited on so an interrupt is serviced now rather than after
# the build it is meant to cancel has finished on its own.
if ! wait "$docker_pid"; then
  echo -e "${RED}build failed${NC}" >&2
  tail -25 "$OUT/build.log" >&2
  exit 1
fi
BUILD_CONTAINER=""
grep -E "^  (OK|FAIL|link|windres)" "$OUT/build.log" || true

# A binary of the wrong architecture is the failure that produces a correctly
# named file nobody can run, so it is checked rather than assumed.
if want dll; then
  file "$OUT/UberSDRIntf.dll" | grep -q "PE32 executable (DLL).*80386" \
    || { echo -e "${RED}UberSDRIntf.dll is not a 32-bit PE:${NC} $(file -b "$OUT/UberSDRIntf.dll")" >&2; exit 1; }
  echo "  UberSDRIntf.dll    $(du -h "$OUT/UberSDRIntf.dll" | cut -f1)  32-bit"
fi
if want monitor; then
  file "$OUT/UberSDRMonitor.exe" | grep -q "PE32+ executable.*x86-64" \
    || { echo -e "${RED}UberSDRMonitor.exe is not a 64-bit PE:${NC} $(file -b "$OUT/UberSDRMonitor.exe")" >&2; exit 1; }
  echo "  UberSDRMonitor.exe $(du -h "$OUT/UberSDRMonitor.exe" | cut -f1)  64-bit"
fi

if [ "$DO_ZIP" -eq 1 ]; then
  command -v zip >/dev/null 2>&1 || { echo -e "${RED}zip is required for --zip${NC}" >&2; exit 1; }
  dest="${ZIP_DIR:-$OUT}"
  mkdir -p "$dest"
  zipfile="$(cd "$dest" && pwd)/CW_Skimmer.zip"
  rm -f "$zipfile"
  # The same three members the published archive has always had, and the ini
  # comes from the source tree rather than the build.
  staging="$(mktemp -d)"
  cp "$OUT/UberSDRIntf.dll" "$OUT/UberSDRMonitor.exe" "$staging/"
  cp UberSDRIntf.ini "$staging/"
  (cd "$staging" && zip -q "$zipfile" UberSDRIntf.dll UberSDRIntf.ini UberSDRMonitor.exe)
  rm -rf "$staging"
  echo
  echo -e "${GREEN}Packaged${NC} $zipfile"
  unzip -l "$zipfile" | sed 's/^/  /'
fi

# Uploads the archive this run built to the rolling release, replacing what is
# there. Only the zip: the DLL and the monitor are published inside it, which is
# how the asset has always been shaped.
publish_release() {
  local zipfile="$1"
  if ! command -v gh >/dev/null 2>&1; then
    echo "not published: gh not found — install the GitHub CLI, or upload $zipfile by hand." >&2
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
  if [ ! -f "$zipfile" ]; then
    echo "not published: $zipfile does not exist." >&2
    return
  fi

  # Both members must be present and the right architecture. Publishing a zip
  # with a 64-bit DLL in it would be accepted by GitHub and rejected by CW
  # Skimmer, which loads it into a 32-bit process.
  if ! unzip -l "$zipfile" | grep -q "UberSDRIntf.dll" || \
     ! unzip -l "$zipfile" | grep -q "UberSDRMonitor.exe"; then
    echo "not published: $zipfile is missing one of its members." >&2
    return
  fi

  echo "  Upload to https://github.com/$REPO/releases/tag/$TAG, replacing what is there:"
  echo "      $ASSET   $(du -h --apparent-size "$zipfile" | cut -f1)"
  echo

  # The prompt is the default and stays that way: publishing replaces what every
  # download link serves. `--yes` changes only when the answer was given, and is
  # a flag rather than an environment variable so a `yes` meant for one release
  # cannot sit there authorising the next.
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

  # --clobber because the asset name is a constant.
  local tmpdir; tmpdir="$(mktemp -d)"
  cp "$zipfile" "$tmpdir/$ASSET"
  if gh release upload "$TAG" "$tmpdir/$ASSET" --clobber --repo "$REPO"; then
    echo "  uploaded to https://github.com/$REPO/releases/tag/$TAG"
  else
    echo "not published: the upload failed — $zipfile is intact, try again." >&2
  fi
  rm -rf "$tmpdir"
}

if [ "$DO_PUBLISH" -eq 1 ]; then
  echo
  publish_release "$zipfile"
fi
