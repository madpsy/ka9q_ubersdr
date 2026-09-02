#!/usr/bin/env bash
# build-inside.sh — the half of build.sh that runs in the container.
#
# Separate from build.sh because it is what the container executes, and keeping
# it a file rather than a quoted string means the compiler flags are readable and
# diffable rather than escaped twice.
set -euo pipefail
TARGETS="${1:-dll monitor}"

# Everything written under /w must end up owned by whoever ran build.sh, not by
# root. On any exit, not just success: a failed build still leaves objects and a
# log behind, and a root-owned dist/ cannot be cleaned by the next run.
give_back() {
  [ -n "${HOST_UID:-}" ] && chown -R "${HOST_UID}:${HOST_GID:-$HOST_UID}" /w/dist 2>/dev/null || true
}
trap give_back EXIT
want() { case " $TARGETS " in *" $1 "*) return 0;; *) return 1;; esac; }

export DEBIAN_FRONTEND=noninteractive
if ! command -v i686-w64-mingw32-g++ >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq g++-mingw-w64-i686 g++-mingw-w64-x86-64 \
                        binutils-mingw-w64-i686 binutils-mingw-w64-x86-64 >/dev/null
fi
# The default alternative is the win32 threading model, which has no std::mutex
# or std::thread; IXWebSocket needs both.
for a in i686 x86_64; do
  for t in g++ gcc; do
    update-alternatives --set "${a}-w64-mingw32-${t}" "/usr/bin/${a}-w64-mingw32-${t}-posix" >/dev/null 2>&1 || true
  done
done

mkdir -p /w/dist /tmp/obj

if want dll; then
  cd /w/UberSDRIntf
  CXX=i686-w64-mingw32-g++
  # -ffunction-sections with --gc-sections below lets the linker drop the parts
  # of static libstdc++ this DLL never calls; MSVC's linker does the equivalent
  # (/OPT:REF) by default in Release.
  #
  # NOT -fdata-sections. It moves large zero-initialised globals out of .bss,
  # which costs nothing in the file, and into .data, which is stored in full:
  # measured here it grew UberSDRMonitor.exe from 72 KB to 2.1 MB, all of it one
  # .data section.
  FLAGS="-std=c++17 -O2 -ffunction-sections -DUBERSDRINTF_EXPORTS -DIXWEBSOCKET_USE_TLS=0 -DIXWEBSOCKET_USE_OPEN_SSL=0 -D_WIN32_WINNT=0x0601 -I. -IIXWebSocket -w"
  # The IXWebSocket units CMakeLists lists, read from it so the two cannot drift.
  IXSRC=$(sed -n '/target_sources(UberSDRIntf PRIVATE/,/^)/p' CMakeLists.txt | grep -oE 'IXWebSocket/ixwebsocket/[A-Za-z]+\.cpp' || true)
  objs=""
  for f in UberSDRIntf.cpp UberSDR.cpp UberSDRShared.cpp IXSocketFactoryStub.cpp IXUserAgentStub.cpp $IXSRC; do
    o="/tmp/obj/$(echo "$f" | tr '/' '_' | sed 's/\.cpp$/.o/')"
    if $CXX $FLAGS -c "$f" -o "$o" 2>/tmp/obj/err; then objs="$objs $o"
    else echo "  FAIL $f"; grep -E "error:" /tmp/obj/err | head -5; exit 1; fi
  done
  echo "  OK   $(echo $objs | wc -w) objects (dll)"
  $CXX -shared -o /w/dist/UberSDRIntf.dll $objs UberSDRIntf.def \
    -static -static-libgcc -static-libstdc++ -Wl,--gc-sections \
    -lws2_32 -lcrypt32 -lrpcrt4 -Wl,--enable-stdcall-fixup
  i686-w64-mingw32-strip --strip-unneeded /w/dist/UberSDRIntf.dll
  echo "  link OK  UberSDRIntf.dll"
fi

if want monitor; then
  cd /w/UberSDRMonitor
  CXX=x86_64-w64-mingw32-g++
  x86_64-w64-mingw32-windres UberSDRMonitor.rc -O coff -o /tmp/obj/res.o
  echo "  windres OK"
  # ANSI WinMain, not wmain: the entry point is WinMain(HINSTANCE,...,LPSTR,int)
  # and CMakeLists disables UNICODE for MSVC, so -municode would be wrong.
  $CXX -std=c++17 -O2 -ffunction-sections -D_WIN32_WINNT=0x0601 -w \
    -o /w/dist/UberSDRMonitor.exe UberSDRMonitor.cpp ../UberSDRIntf/UberSDRShared.cpp /tmp/obj/res.o \
    -mwindows -static -static-libgcc -static-libstdc++ -Wl,--gc-sections \
    -lcomctl32 -lws2_32 -lmsimg32 -lgdi32 -lcomdlg32 -lshell32 -lole32 -luuid -lrpcrt4
  x86_64-w64-mingw32-strip --strip-unneeded /w/dist/UberSDRMonitor.exe
  echo "  link OK  UberSDRMonitor.exe"
fi
