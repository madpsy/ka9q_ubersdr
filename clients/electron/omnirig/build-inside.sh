#!/usr/bin/env bash
# build-inside.sh — the half of build.sh that runs in the container.
#
# A file rather than a quoted `bash -c` string, as in clients/CW_Skimmer: an
# apostrophe in a comment inside a single-quoted script ends the quote, and the
# build goes on to exit 0 having built nothing.
set -euo pipefail
TARGETS="${1:-helper}"

# Everything written under /w/dist must end up owned by whoever ran build.sh, on
# any exit — a root-owned dist/ cannot be cleaned by the next run.
give_back() {
  [ -n "${HOST_UID:-}" ] && chown -R "${HOST_UID}:${HOST_GID:-$HOST_UID}" /w/dist 2>/dev/null || true
}
trap give_back EXIT
want() { case " $TARGETS " in *" $1 "*) return 0;; *) return 1;; esac; }

export DEBIAN_FRONTEND=noninteractive
if ! command -v x86_64-w64-mingw32-g++ >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq g++-mingw-w64-x86-64 binutils-mingw-w64-x86-64 >/dev/null
fi

CXX=x86_64-w64-mingw32-g++
# Static, so the exe runs on a Windows with no mingw runtime beside it. Nothing
# here uses std::thread, so the default win32 threading model is enough.
FLAGS="-std=c++17 -O2 -Wall -ffunction-sections -D_WIN32_WINNT=0x0601"
LINK="-static -static-libgcc -static-libstdc++ -Wl,--gc-sections"
mkdir -p /w/dist/test

cd /w
if want helper; then
  $CXX $FLAGS -o dist/omnirig-helper.exe omnirig_helper.cpp omnirig_core.cpp \
    $LINK -lole32 -loleaut32 -luuid -luser32
  x86_64-w64-mingw32-strip --strip-unneeded dist/omnirig-helper.exe
  echo "  link OK  omnirig-helper.exe"
fi

if want fake; then
  $CXX $FLAGS -shared -o dist/test/fake_omnirig.dll test/fake_omnirig.cpp \
    $LINK -lole32 -loleaut32 -luuid
  x86_64-w64-mingw32-strip --strip-unneeded dist/test/fake_omnirig.dll
  echo "  link OK  fake_omnirig.dll"
fi
