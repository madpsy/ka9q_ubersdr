#!/usr/bin/env bash
# build.sh — build radio_client for Linux and Windows, and publish them.
#
# PyInstaller cannot cross-compile: it bundles the interpreter and the native
# extension modules of whatever it is running on, so a Linux run produces an ELF
# and only a Windows run produces an .exe. That is the whole reason this script
# is two different build paths rather than a loop over a target list.
#
# The Windows half therefore runs under wine in a container, the same way
# clients/python_iq_recorder/build.sh builds iq_recorder.exe. The image
# supplies wine and the VC++ runtime; the Windows Python itself, with tkinter --
# radio_client is also the Tk GUI -- is installed into the container on each run
# from python.org's per-component MSIs (see WIN_PY_VERSION for why), downloaded
# once into a cache. Nothing is installed on the host and no wine prefix of
# yours is touched.
#
# Not built: macOS and Linux arm64. For the same reason -- no cross-compiling --
# each needs a run on that platform (a Mac, an arm64 Linux box), and the release
# does not carry either. People there run radio_client.py from source, which is
# what the README describes.
#
# build-windows.py and build-windows.bat stay, for building the .exe on Windows
# itself. They run the same radio_client.spec.
#
# Usage:
#   ./build.sh                 both into dist/
#   ./build.sh linux           just the one -- linux or windows
#   ./build.sh --test          run the decoder and tuning-range tests first
#   ./build.sh --publish       ...then upload what this run built to the `latest`
#                              release, replacing what is there. Asks first.
#   ./build.sh --publish-only  upload what is already in dist/ without building,
#                              after the same bundle checks a build runs. For
#                              binaries a build has just made and smoke-tested;
#                              warns if the sources are newer than them.
#   ./build.sh --yes           answer the publish prompt in advance, for a run
#                              with nobody at the terminal. Only with --publish
#                              or --publish-only.
#   ./build.sh --clean         remove dist/ and build/ first
#
# Environment: UBERSDR_REPO and UBERSDR_TAG choose where --publish uploads
# (default madpsy/ka9q_ubersdr, latest); UBERSDR_WIN_IMAGE the wine image;
# UBERSDR_WIN_PY_VERSION the Windows Python (empty: the image's own).

set -euo pipefail

cd "$(dirname "$0")"

OUT="dist"
VENV=".venv"

# The release assets, and the filenames PyInstaller already produces. The
# download buttons point at exactly these names; do not rename them.
LINUX_ASSET="radio_client"
WIN_ASSET="radio_client.exe"

REPO="${UBERSDR_REPO:-madpsy/ka9q_ubersdr}"
TAG="${UBERSDR_TAG:-latest}"

# The wine image. Pinned by name rather than digest because it is a build tool
# rather than something that ships, but it is worth knowing what it must supply:
# a wine new enough for numpy 2 (wine 9.0 lacks ucrtbase.crealf, and numpy dies
# importing) and the real VC++ runtime in system32 -- samplerate and rtmidi link
# MSVCP140, and wine's builtin stand-in would be bundled otherwise (the bundle
# check below refuses that).
WIN_IMAGE="${UBERSDR_WIN_IMAGE:-batonogov/pyinstaller-windows:latest}"

# The Windows Python the exe is built with, and so the one it carries.
#
# Not the image's own, which is 3.13: python-rtmidi publishes no Windows wheel
# for 3.13, there is no compiler under wine to build one, and without it the
# exe loses the MIDI controller support the hand-built 3.13 releases had (they
# compiled rtmidi with MSVC on Windows). 3.12 has a wheel for everything in
# requirements.txt, and 3.12.10 is the last 3.12 with Windows installers. The
# full installer cannot run headless under wine (its bootstrapper wants a
# window), but its component MSIs install quietly with msiexec. Set
# UBERSDR_WIN_PY_VERSION= (empty) to build with the image's Python instead.
WIN_PY_VERSION="${UBERSDR_WIN_PY_VERSION-3.12.10}"
WIN_PY_MSIS="core exe lib tcltk dev"
WIN_PY_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/ubersdr-build/python-$WIN_PY_VERSION-amd64"

# What the Windows build must have, installed and importable, or it fails.
#
# The template build treats the audio extras as optional; this one cannot. The
# stream's rate now changes mid-session -- 24 kHz in AM, 12 kHz in SSB -- and a
# WASAPI shared-mode device accepts only the mixer rate, so sounddevice and
# PyAudio output on Windows go through samplerate to 48 kHz. An exe without
# samplerate opens 12 and 24 kHz streams that Windows refuses. sounddevice is the
# default audio output, and opuslib the Opus decoder. Everything else in
# requirements.txt is installed too, but only warned about if it fails: each is
# behind a try/except in the client and costs one feature.
WIN_REQUIRED="requests websockets websocket-client aiohttp numpy zstandard samplerate sounddevice opuslib"
# The import names for the check, which are not all the package names.
WIN_REQUIRED_IMPORTS="requests websockets websocket aiohttp numpy zstandard samplerate sounddevice opuslib"

RUN_TESTS=0
PUBLISH=0
PUBLISH_ONLY=0
ASSUME_YES=0
CLEAN=0

# What an interrupt has to take with it.
#
# The Windows build runs in a container against a staging directory, and neither
# is a child of this shell: killing the script leaves the container compiling
# stale source and the staging directory behind, root-owned so that even rm
# cannot clear it. A `trap ... RETURN` inside the function does not help, because
# an interrupt never returns from it. So the two live here and are torn down on
# any exit, ordinary or not.
BUILD_CONTAINER=""
BUILD_STAGE=""

cleanup() {
  local status=$?
  if [ -n "$BUILD_CONTAINER" ] && docker ps -q --filter "name=^${BUILD_CONTAINER}$" 2>/dev/null | grep -q .; then
    echo "  stopping build container $BUILD_CONTAINER" >&2
    docker kill "$BUILD_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [ -n "$BUILD_STAGE" ] && [ -d "$BUILD_STAGE" ]; then
    # The container wrote as root, so hand ownership back before removing --
    # otherwise this rm fails and the directory survives the cleanup meant to
    # remove it.
    if ! rm -rf "$BUILD_STAGE" 2>/dev/null; then
      docker run --rm --entrypoint /bin/sh -v "$BUILD_STAGE:/stage" "$WIN_IMAGE" \
        -c "chown -R $(id -u):$(id -g) /stage" >/dev/null 2>&1 || true
      rm -rf "$BUILD_STAGE" 2>/dev/null || true
    fi
  fi
  BUILD_CONTAINER=""
  BUILD_STAGE=""
  return $status
}
trap cleanup EXIT INT TERM

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

TARGETS=()
WANTED=()
for arg in "$@"; do
  case "$arg" in
    --test) RUN_TESTS=1 ;;
    --publish) PUBLISH=1 ;;
    --publish-only) PUBLISH=1; PUBLISH_ONLY=1 ;;
    --yes) ASSUME_YES=1 ;;
    --clean) CLEAN=1 ;;
    -h|--help) sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    linux|windows) WANTED+=("$arg") ;;
    *) echo "unknown target: $arg (expected linux or windows)" >&2; exit 2 ;;
  esac
done
if [ ${#WANTED[@]} -gt 0 ]; then TARGETS=("${WANTED[@]}"); else TARGETS=(linux windows); fi
if [ "$ASSUME_YES" -eq 1 ] && [ "$PUBLISH" -eq 0 ]; then
  echo "--yes only answers the --publish prompt; nothing to answer without --publish." >&2
  exit 2
fi
if [ "$PUBLISH_ONLY" -eq 1 ] && { [ "$RUN_TESTS" -eq 1 ] || [ "$CLEAN" -eq 1 ]; }; then
  echo "--publish-only builds nothing, so --test and --clean have nothing to act on." >&2
  exit 2
fi

want() { local t; for t in "${TARGETS[@]}"; do [ "$t" = "$1" ] && return 0; done; return 1; }

# --------------------------------------------------------------------------
# Preflight
# --------------------------------------------------------------------------

# Checked here rather than left to PyInstaller, whose failure for a missing
# file is a stack trace three screens long -- or, for the DLL, no failure at
# all, just an exe that cannot decode Opus.
for required in radio_client.py radio_client.spec pcm_v4.py pcm_v4_native.c tuning_range.py requirements.txt ubersdr.ico; do
  if [ ! -f "$required" ]; then
    echo -e "${RED}$required is missing.${NC}" >&2
    exit 1
  fi
done
if want windows && [ ! -f opus.dll ]; then
  # opus.dll is checked in: the official 64-bit build from xiph's opus-tools,
  # which is what download_opus_dll.py fetches. Run that on Windows, or take the
  # DLL from the zip it names, if this ever goes missing.
  echo -e "${RED}opus.dll is missing -- the Windows build bundles it for opuslib (see download_opus_dll.py).${NC}" >&2
  exit 1
fi

if [ "$CLEAN" -eq 1 ] && [ "$PUBLISH_ONLY" -eq 0 ]; then
  echo "Cleaning dist/ and build/"
  rm -rf dist build
fi

# The venv is needed for the Windows build too: the bundle checks below read the
# .exe with PyInstaller's own archive reader, from the host.
#
# A venv rather than the system Python: PyInstaller freezes whatever is
# importable, so building against system site-packages bundles whatever else
# happens to be installed there.
ensure_venv() {
  if [ ! -x "$VENV/bin/python" ]; then
    echo "  creating $VENV"
    python3 -m venv "$VENV"
    "$VENV/bin/pip" install -q --upgrade pip
  fi
  echo "  installing requirements"
  "$VENV/bin/pip" install -q -r requirements.txt || {
    echo -e "${YELLOW}  some requirements failed; continuing with what installed${NC}" >&2
  }
  "$VENV/bin/python" -c 'import PyInstaller' 2>/dev/null || "$VENV/bin/pip" install -q 'pyinstaller>=6.17'
}

echo -e "${GREEN}Preparing $VENV${NC}"
ensure_venv
echo

# The decoder's conformance test runs before building, not after: a predictor
# that has drifted from the server returns plausible noise rather than an
# error, and shipping that is worse than shipping nothing.
if [ "$RUN_TESTS" -eq 1 ]; then
  echo -e "${GREEN}Testing${NC}"
  # The native library first, so the first run exercises it.
  gcc -O2 -shared -fPIC -o pcm_v4_native.so pcm_v4_native.c
  "$VENV/bin/python" -m unittest test_pcm_v4 test_tuning_range test_spectrum_v2 -q
  # Again through the pure Python decoder the client falls back to. Both must
  # match the server's stream bit for bit.
  UBERSDR_PCMV4_PURE=1 "$VENV/bin/python" -m unittest test_pcm_v4 -q
  echo
fi

# --------------------------------------------------------------------------
# Native protocol decoder
# --------------------------------------------------------------------------

# pcm_v4_native.c is the version 4 payload codec in C. pcm_v4.py falls back to
# pure Python without it, but that fallback cannot keep up with iq96 and above
# and holds the GIL while it tries -- and the frozen builds shipped without it
# for exactly that reason: nothing built it and the spec did not list it. So a
# build that cannot compile it fails rather than shipping the slow path.
# Compiled on the host for both targets: the Windows image has a Python but no C
# compiler, and MinGW cross-compiles a DLL that needs nothing beyond what
# Windows ships. AVX2 is picked at run time inside the library, so one build
# serves every x86-64.
build_native() {
  case "$1" in
    linux)
      command -v gcc >/dev/null 2>&1 || { echo -e "${RED}gcc is needed to build pcm_v4_native.so${NC}" >&2; return 1; }
      gcc -O2 -shared -fPIC -o pcm_v4_native.so pcm_v4_native.c
      ;;
    windows)
      command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1 || {
        echo -e "${RED}x86_64-w64-mingw32-gcc is needed to build pcm_v4_native.dll (apt install gcc-mingw-w64-x86-64)${NC}" >&2
        return 1
      }
      x86_64-w64-mingw32-gcc -O2 -shared -static-libgcc -o pcm_v4_native.dll pcm_v4_native.c
      ;;
  esac
}

if [ "$PUBLISH_ONLY" -eq 0 ]; then
  for t in "${TARGETS[@]}"; do
    build_native "$t" || exit 1
  done
fi

# --------------------------------------------------------------------------
# Build checks
# --------------------------------------------------------------------------

# Is everything that matters actually inside the binary?
#
# PyInstaller does not fail for a library it could not find. It records a
# warning, and the build succeeds with a binary of the right size and format
# that then runs without the codec, or prints "opuslib installed but Opus DLL
# not found", on the user's machine. The previous Windows exes were bundling
# opus.dll only when it happened to be on PATH at build time. So the archive's
# table of contents is read here, from the host, with PyInstaller's own reader.
#
# Each pattern is a regular expression that some entry must match.
#
# On Windows it also refuses a wine stub. Wine provides its own builtin
# MSVCP140.dll and friends, marked "Wine builtin DLL" in their DOS stub, and a
# PyInstaller run under wine can pick those up when the real VC++ runtime is not
# beside Python. They run under wine and nowhere else -- samplerate, for one,
# links against MSVCP140 -- so an exe carrying one is broken on Windows however
# well it smoke-tests here.
check_bundle() {
  local bin="$1"; shift
  "$VENV/bin/python" - "$bin" "$@" <<'PY'
import re, sys
from PyInstaller.archive.readers import CArchiveReader

path, patterns = sys.argv[1], sys.argv[2:]
arch = CArchiveReader(path)
names = list(arch.toc)
bad = False
for pat in patterns:
    hits = [n for n in names if re.search(pat, n, re.IGNORECASE)]
    if hits:
        print(f"    bundled: {hits[0]}" + (f" (+{len(hits) - 1})" if len(hits) > 1 else ""))
    else:
        print(f"    MISSING: nothing matches {pat}")
        bad = True
for n in names:
    if n.lower().endswith('.dll'):
        data = arch.extract(n)
        if data and (b'Wine builtin DLL' in data[:1024] or b'Wine placeholder DLL' in data[:1024]):
            print(f"    WINE STUB: {n} is wine's builtin DLL, not the real one")
            bad = True
sys.exit(1 if bad else 0)
PY
}

# --------------------------------------------------------------------------
# Linux
# --------------------------------------------------------------------------

build_linux() {
  echo -e "${GREEN}Building $LINUX_ASSET for Linux${NC}"

  "$VENV/bin/python" -m PyInstaller --clean --noconfirm radio_client.spec > build-linux.log 2>&1 || {
    tail -20 build-linux.log >&2
    echo -e "${RED}  PyInstaller failed; the full log is build-linux.log${NC}" >&2
    return 1
  }

  if [ ! -f "$OUT/$LINUX_ASSET" ]; then
    echo -e "${RED}  build produced no $OUT/$LINUX_ASSET${NC}" >&2
    return 1
  fi

  # libopus is the system one, which PyInstaller finds through opuslib's
  # find_library('opus') and bundles; the frozen client loads the bundled copy.
  echo "  checking the bundle"
  check_bundle "$OUT/$LINUX_ASSET" \
    '^pcm_v4_native\.so$' '^libopus\.so' '^samplerate\..*\.so$' 'portaudio' '_tkinter\.cpython' 'rtmidi/_rtmidi' || {
    echo -e "${RED}  $OUT/$LINUX_ASSET is missing something it needs${NC}" >&2
    return 1
  }

  # It starts, and without the "not available" warnings a missing optional
  # module prints at import. --help imports everything radio_client imports at
  # the top, so this is the cheapest run that would show one.
  local warn
  warn=$("$OUT/$LINUX_ASSET" --help 2>&1 >/dev/null | grep -iE 'warning|error|traceback' || true)
  if [ -n "$warn" ]; then
    echo -e "${RED}  $OUT/$LINUX_ASSET --help complained:${NC}" >&2
    echo "$warn" >&2
    return 1
  fi
  echo "  $OUT/$LINUX_ASSET  $(du -h "$OUT/$LINUX_ASSET" | cut -f1)"
}

# --------------------------------------------------------------------------
# Windows, under wine in a container
# --------------------------------------------------------------------------

build_windows() {
  echo -e "${GREEN}Building $WIN_ASSET for Windows (wine, $WIN_IMAGE)${NC}"

  if ! command -v docker >/dev/null 2>&1; then
    echo -e "${RED}  docker is needed for the Windows build (PyInstaller cannot cross-compile).${NC}" >&2
    return 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo -e "${RED}  docker is installed but not usable -- is the daemon running, and are you in the docker group?${NC}" >&2
    return 1
  fi

  # Staged rather than bind-mounting the source tree: this directory accumulates
  # a Linux .venv/, build/ and dist/, and the Linux pcm_v4_native.so, none of
  # which may be copied into a Windows build or shipped inside it -- and the
  # container writes as root, which would leave root-owned files here.
  local stage
  stage="$(mktemp -d)"
  BUILD_STAGE="$stage"
  # Named so the trap can find it, and prefixed so it collides with nothing
  # else on the box. A container started with --rm still has to be killed by
  # name when the script dies: --rm removes it once it stops, and nothing
  # stops it otherwise.
  BUILD_CONTAINER="ubersdr-pyclient-build-$$"

  # The Windows Python's MSIs, fetched once. Each is downloaded to a .part and
  # renamed, so an interrupted download is not mistaken for a complete one.
  local msi_mount=()
  if [ -n "$WIN_PY_VERSION" ]; then
    mkdir -p "$WIN_PY_CACHE"
    local msi
    for msi in $WIN_PY_MSIS; do
      [ -s "$WIN_PY_CACHE/$msi.msi" ] && continue
      echo "  fetching Python $WIN_PY_VERSION $msi.msi"
      if curl -fsSL -o "$WIN_PY_CACHE/$msi.msi.part" \
          "https://www.python.org/ftp/python/$WIN_PY_VERSION/amd64/$msi.msi"; then
        mv "$WIN_PY_CACHE/$msi.msi.part" "$WIN_PY_CACHE/$msi.msi"
      else
        rm -f "$WIN_PY_CACHE/$msi.msi.part"
        echo -e "${RED}  could not download Python $WIN_PY_VERSION's $msi.msi${NC}" >&2
        return 1
      fi
    done
    msi_mount=(-v "$WIN_PY_CACHE:/msi:ro")
  fi

  mkdir -p "$stage/src"
  tar -cf - --exclude=.venv --exclude=venv --exclude=build --exclude=dist --exclude=__pycache__ \
      --exclude=testdata --exclude='*.so' --exclude='*.wav' --exclude='*.pyc' --exclude='*.log' . \
    | tar -xf - -C "$stage/src"

  # The container's half, as a file rather than an inline `sh -c '...'`: it
  # runs a loop over requirements.txt with its own quoting, and an apostrophe in
  # an inline script silently truncates it while docker still exits 0.
  cat > "$stage/winbuild.sh" <<'CONTAINER'
set -e
cd /w/src
# wine's Python writes its redirected streams in the ANSI code page, and the
# first non-ASCII character pip or radio_client prints would kill it.
export PYTHONIOENCODING=utf-8

PY=python
if [ -n "$WIN_PY_VERSION" ]; then
  echo "== installing Python $WIN_PY_VERSION"
  for msi in $WIN_PY_MSIS; do
    wine msiexec /i "Z:\\msi\\$msi.msi" 'TARGETDIR=C:\PyBuild' ALLUSERS=1 /qn
  done
  PY='C:\PyBuild\python.exe'
  wine "$PY" -m ensurepip >/dev/null
fi
echo "== $(wine "$PY" --version)"

echo "== required: $WIN_REQUIRED"
wine "$PY" -m pip install --no-input -q --no-warn-script-location $WIN_REQUIRED 'pyinstaller>=6.17'

echo "== optional, from requirements.txt"
grep -vE '^[[:space:]]*(#|$)' requirements.txt | while IFS= read -r req; do
  name=$(printf '%s' "$req" | sed -E 's/[<>=!~;[:space:]].*//')
  case " $WIN_REQUIRED pyinstaller " in
    *" $name "*) continue ;;
  esac
  wine "$PY" -m pip install --no-input -q --no-warn-script-location "$req" >/dev/null 2>&1 \
    && echo "  $name" || echo "  optional dep $name unavailable for this Python"
done

# Importable, not just installed: a wheel can install and still fail to load a
# DLL under the image's wine. opuslib loads opus.dll at import through
# find_library, which searches PATH, so the staged copy goes on it the way
# radio_client.py puts sys._MEIPASS on it in the frozen exe.
echo "== import check: $WIN_REQUIRED_IMPORTS"
wine "$PY" -c "
import os, sys
os.environ['PATH'] = os.getcwd() + os.pathsep + os.environ.get('PATH', '')
failed = []
for m in sys.argv[1:]:
    try:
        __import__(m)
    except Exception as e:
        failed.append(m)
        print('  cannot import %s: %r' % (m, e))
sys.exit(1 if failed else 0)
" $WIN_REQUIRED_IMPORTS

wine "$PY" -m PyInstaller --clean --noconfirm radio_client.spec

# Does the exe start? --help imports everything radio_client imports at the top,
# so a missing module prints its "not available" warning here. --list-devices
# exercises sounddevice and its bundled PortAudio. Piped through cat: wine's
# Python dies with "init_sys_streams: Invalid handle" when a stream is
# redirected straight to a file.
timeout 120 wine dist/radio_client.exe --help 2>&1 | cat > /w/help.txt || true
timeout 120 wine dist/radio_client.exe --list-devices 2>&1 | cat > /w/devices.txt || true
CONTAINER

  # One container run: the image is not committed, so a separate install run
  # would be thrown away before PyInstaller ever saw it.
  #
  # Backgrounded and waited on rather than run in the foreground. Bash defers a
  # trap until the current foreground command finishes, so with `docker run` in
  # front the cleanup handler would not execute until the build it is supposed
  # to cancel had finished on its own -- which is exactly the case that leaves a
  # container compiling stale source after Ctrl-C. `wait` is interruptible, so
  # the signal is serviced immediately and the trap kills the container by name.
  #
  # The chown afterwards, in the same run: everything the container wrote is
  # root-owned, and the staging directory could not otherwise be removed by
  # whoever ran this script.
  docker run --rm --name "$BUILD_CONTAINER" --entrypoint /bin/sh \
    -e WIN_REQUIRED="$WIN_REQUIRED" -e WIN_REQUIRED_IMPORTS="$WIN_REQUIRED_IMPORTS" \
    -e WIN_PY_VERSION="$WIN_PY_VERSION" -e WIN_PY_MSIS="$WIN_PY_MSIS" \
    -v "$stage:/w" ${msi_mount[@]+"${msi_mount[@]}"} "$WIN_IMAGE" \
    -c "sh /w/winbuild.sh; status=\$?; chown -R $(id -u):$(id -g) /w; exit \$status" \
    > "$stage/build.log" 2>&1 &
  local docker_pid=$! docker_status=0
  wait "$docker_pid" || docker_status=$?
  # Kept, with what the exe printed under wine, for when a check below fails.
  {
    cat "$stage/build.log"
    echo "== radio_client.exe --help under wine";         cat "$stage/help.txt" 2>/dev/null
    echo "== radio_client.exe --list-devices under wine"; cat "$stage/devices.txt" 2>/dev/null
  } > build-windows.log
  grep -viE '^wine|err:|fixme|XDG_RUNTIME_DIR|winbth|^[0-9]+ INFO' "$stage/build.log" | tail -15

  if [ "$docker_status" -ne 0 ]; then
    echo -e "${RED}  the container build failed (exit $docker_status); the full log is build-windows.log${NC}" >&2
    return 1
  fi
  if [ ! -f "$stage/src/dist/$WIN_ASSET" ]; then
    echo -e "${RED}  build produced no $WIN_ASSET${NC}" >&2
    return 1
  fi

  mkdir -p "$OUT"
  cp "$stage/src/dist/$WIN_ASSET" "$OUT/$WIN_ASSET"

  # A Linux ELF here would mean the wine python was not used and the build
  # silently fell back to the container's own interpreter -- which produces a
  # file with the right name that no Windows machine can run. And a few hundred
  # kilobytes means wine wrote a stub and exited 0: the real exe, carrying
  # Python, numpy, scipy and Tk, is over 50 MB.
  local size
  size=$(stat -c %s "$OUT/$WIN_ASSET")
  if ! file "$OUT/$WIN_ASSET" | grep -q 'PE32+'; then
    echo -e "${RED}  $OUT/$WIN_ASSET is not a Windows executable:${NC}" >&2
    file "$OUT/$WIN_ASSET" >&2
    rm -f "$OUT/$WIN_ASSET"
    return 1
  fi
  if [ "$size" -lt $((50 * 1024 * 1024)) ]; then
    echo -e "${RED}  $OUT/$WIN_ASSET is only $size bytes -- not a complete build${NC}" >&2
    rm -f "$OUT/$WIN_ASSET"
    return 1
  fi

  echo "  checking the bundle"
  check_bundle "$OUT/$WIN_ASSET" \
    '^pcm_v4_native\.dll$' '^opus\.dll$' '^samplerate\..*\.pyd$' \
    'portaudio-binaries.libportaudio64bit\.dll$' '^_tkinter\.pyd$' '^MSVCP140\.dll$' \
    '^rtmidi.*\.pyd$' || {
    echo -e "${RED}  $OUT/$WIN_ASSET is missing something it needs, or carries a wine stub${NC}" >&2
    rm -f "$OUT/$WIN_ASSET"
    return 1
  }

  # The exe's own word, from its run under wine in the container.
  if [ ! -s "$stage/help.txt" ] || ! grep -q -- '--frequency' "$stage/help.txt"; then
    echo -e "${RED}  $WIN_ASSET --help did not run under wine:${NC}" >&2
    tail -20 "$stage/help.txt" >&2 2>/dev/null || true
    rm -f "$OUT/$WIN_ASSET"
    return 1
  fi
  local warn
  warn=$(grep -iE '^warning|^error|traceback|failed to execute' "$stage/help.txt" || true)
  if [ -n "$warn" ]; then
    echo -e "${RED}  $WIN_ASSET --help complained under wine:${NC}" >&2
    echo "$warn" >&2
    rm -f "$OUT/$WIN_ASSET"
    return 1
  fi
  if grep -iqE 'traceback|failed to execute' "$stage/devices.txt"; then
    echo -e "${RED}  $WIN_ASSET --list-devices failed under wine:${NC}" >&2
    tail -20 "$stage/devices.txt" >&2
    rm -f "$OUT/$WIN_ASSET"
    return 1
  fi
  echo "  --help and --list-devices ran under wine without warnings"
  echo "  $OUT/$WIN_ASSET  $(du -h "$OUT/$WIN_ASSET" | cut -f1)"
}

# --------------------------------------------------------------------------
# Already built (--publish-only)
# --------------------------------------------------------------------------

# The checks a build ends with, run on what is already in dist/ -- everything
# but the wine run of the .exe, which needs the container the build had and is
# the build's to vouch for. Not a substitute for building: it cannot tell which
# source a binary came from. What it can say is whether anything the binaries
# are built from was committed after them, which is the stale-binary mistake
# this option makes easy, so that is said before the prompt rather than after.
SOURCES=(radio_client.py radio_client.spec pcm_v4.py pcm_v4_native.c tuning_range.py requirements.txt)

verify_existing() {
  local target="$1" bin="$2"
  echo -e "${GREEN}Checking the existing $bin${NC}"
  if [ ! -f "$bin" ]; then
    echo -e "${RED}  $bin is not there -- build it first (./build.sh $target)${NC}" >&2
    return 1
  fi
  local built newest
  built=$(stat -c %Y "$bin")
  newest=$(git log -1 --format=%at -- "${SOURCES[@]}" 2>/dev/null || echo 0)
  echo "  built $(date -d "@$built" '+%F %T'); sources last committed $(date -d "@${newest:-0}" '+%F %T')"
  if [ -n "$newest" ] && [ "$newest" -gt "$built" ]; then
    echo -e "${YELLOW}  the sources were committed after this binary was built -- it may not contain that change${NC}" >&2
  fi
  if ! git diff --quiet -- "${SOURCES[@]}" 2>/dev/null; then
    echo -e "${YELLOW}  there are uncommitted changes to the sources; the binary cannot contain what is not committed either way${NC}" >&2
  fi

  if [ "$target" = linux ]; then
    if ! file "$bin" | grep -q 'ELF 64-bit'; then
      echo -e "${RED}  $bin is not a Linux executable${NC}" >&2; return 1
    fi
    check_bundle "$bin" \
      '^pcm_v4_native\.so$' '^libopus\.so' '^samplerate\..*\.so$' 'portaudio' '_tkinter\.cpython' 'rtmidi/_rtmidi' || return 1
    local warn
    warn=$("$bin" --help 2>&1 >/dev/null | grep -iE 'warning|error|traceback' || true)
    if [ -n "$warn" ]; then
      echo -e "${RED}  $bin --help complained:${NC}" >&2; echo "$warn" >&2; return 1
    fi
  else
    if ! file "$bin" | grep -q 'PE32+'; then
      echo -e "${RED}  $bin is not a Windows executable${NC}" >&2; return 1
    fi
    if [ "$(stat -c %s "$bin")" -lt $((50 * 1024 * 1024)) ]; then
      echo -e "${RED}  $bin is too small to be a complete build${NC}" >&2; return 1
    fi
    check_bundle "$bin" \
      '^pcm_v4_native\.dll$' '^opus\.dll$' '^samplerate\..*\.pyd$' \
      'portaudio-binaries.libportaudio64bit\.dll$' '^_tkinter\.pyd$' '^MSVCP140\.dll$' \
      '^rtmidi.*\.pyd$' || return 1
  fi
  echo "  $bin  $(du -h "$bin" | cut -f1)"
}

# --------------------------------------------------------------------------
# Publish
# --------------------------------------------------------------------------

# Uploads what this run built to the rolling release, replacing what is there.
#
# What this run built, and not simply what is in dist/: a partial build leaves
# the other binary there from whenever it was last made, and publishing that
# would put a stale binary on the release under a name that says nothing about
# its age. So `./build.sh linux --publish` uploads one file.
BUILT=()

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

  local uploads=("${BUILT[@]}")
  if [ ${#uploads[@]} -eq 0 ]; then
    echo "not published: this run produced nothing to upload." >&2
    return
  fi

  echo "  Upload to https://github.com/$REPO/releases/tag/$TAG, replacing what is there:"
  local asset
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

# --------------------------------------------------------------------------

# A failed target does not stop the other, but it does fail the run, and only
# what passed every check is offered for upload.
FAILED=0
if [ "$PUBLISH_ONLY" -eq 1 ]; then
  if want linux; then
    if verify_existing linux "$OUT/$LINUX_ASSET"; then BUILT+=("$OUT/$LINUX_ASSET"); else FAILED=1; fi
    echo
  fi
  if want windows; then
    if verify_existing windows "$OUT/$WIN_ASSET"; then BUILT+=("$OUT/$WIN_ASSET"); else FAILED=1; fi
    echo
  fi
  # Half a release is worse than none: the two binaries are meant to be the
  # same client, and one stale beside one new says nothing about which is which.
  if [ "$FAILED" -ne 0 ]; then
    echo -e "${RED}Not publishing: a binary failed its checks.${NC}" >&2
    exit 1
  fi
else
  if want linux; then
    if build_linux; then BUILT+=("$OUT/$LINUX_ASSET"); else FAILED=1; fi
    echo
  fi
  if want windows; then
    if build_windows; then BUILT+=("$OUT/$WIN_ASSET"); else FAILED=1; fi
    echo
  fi
fi

if [ "$FAILED" -eq 0 ]; then
  echo -e "${GREEN}Done.${NC} Binaries are in $OUT/:"
else
  echo -e "${RED}A target failed${NC} (see above). Built and checked:"
fi
for b in "${BUILT[@]}"; do
  echo "  $b   $(file -b "$b" | cut -d, -f1-2)"
done

if [ "$PUBLISH" -eq 1 ]; then
  echo
  publish_release
fi

exit "$FAILED"
