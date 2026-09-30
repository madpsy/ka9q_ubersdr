#!/usr/bin/env bash
# build.sh — cross-build omnirig-helper.exe, the desktop client's way to OmniRig.
#
# OmniRig is a Windows COM server; see omnirig_helper.cpp for why it is reached
# through a child process. mingw-w64 in a container builds the helper from Linux
# without Visual Studio, the same way clients/CW_Skimmer builds its DLL.
#
# Usage:
#   ./build.sh           dist/omnirig-helper.exe, which ../build.sh packages
#   ./build.sh --test    that, plus dist/test/fake_omnirig.dll for test/wine_test.sh
#
# The Windows packages of the desktop client pick the helper up from dist/ (see
# build.win.extraResources in ../package.json); ../build.sh runs this first.
set -euo pipefail
cd "$(dirname "$0")"

IMAGE="${UBERSDR_MINGW_IMAGE:-debian:bookworm}"
TARGETS="helper"
while [ $# -gt 0 ]; do
  case "$1" in
    --test) TARGETS="helper fake" ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

command -v docker >/dev/null 2>&1 || { echo "docker is required to build the OmniRig helper" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "docker is not usable — daemon running? in the docker group?" >&2; exit 1; }

mkdir -p dist/test
# The artefacts must come out newer than this, or the build did not write them,
# whatever the container's exit status said.
stamp="$(mktemp)"
trap 'rm -f "$stamp"' EXIT

echo "building the OmniRig helper ($IMAGE, mingw-w64) …"
if ! docker run --rm \
    -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
    -v "$PWD:/w" -w /w "$IMAGE" \
    bash /w/build-inside.sh "$TARGETS" >dist/build.log 2>&1; then
  echo "OmniRig helper build failed:" >&2
  tail -25 dist/build.log >&2
  exit 1
fi

check() {
  local f="$1" kind="$2"
  if [ ! "$f" -nt "$stamp" ]; then
    echo "$f was not rebuilt — see dist/build.log" >&2; exit 1
  fi
  # A wrong-architecture binary is a correctly named file nobody can run.
  file "$f" | grep -q "$kind" || { echo "$f is not a 64-bit PE: $(file -b "$f")" >&2; exit 1; }
  echo "  $f  $(du -h "$f" | cut -f1)"
}
check dist/omnirig-helper.exe "PE32+ executable.*x86-64"
case " $TARGETS " in *" fake "*) check dist/test/fake_omnirig.dll "PE32+ executable (DLL).*x86-64" ;; esac
