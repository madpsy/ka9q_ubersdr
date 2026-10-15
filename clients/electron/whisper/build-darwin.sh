#!/usr/bin/env bash
# build-darwin.sh — the half of build.sh that runs on the Mac.
#
#   build-darwin.sh <whisper.cpp commit>
#
# Run over ssh in a directory holding this tree's sources (build.sh sends them),
# with DEVELOPER_DIR and PATH set as build.sh's mac() sets them. Fetches
# whisper.cpp itself at the pinned commit — git is on every Mac with Xcode — and
# a CMake if the Mac has none, as ../../sdrpp/build.sh does (checked against
# its published sha256 here).
#
# Out comes one universal binary, dist/darwin-universal/whisper-helper, with
# three slices:
#
#   arm64    Apple silicon, at clang's default target for it (apple-m1: dot
#            product and fp16 arithmetic included)
#   x86_64h  Intel Macs from Haswell on: AVX2, FMA, F16C, BMI2
#   x86_64   any other Intel Mac, slowly
#
# The kernel picks x86_64h over x86_64 on a CPU that can run it, so a Mac does
# by itself what whisper_helper.cpp's CPU dispatch does on Linux and Windows,
# with one file.
set -euo pipefail
COMMIT="$1"
cd "$(dirname "$0")"
HERE="$PWD"
SRC="$HERE/build/whisper.cpp"

if [ "$(git -C "$SRC" rev-parse HEAD 2>/dev/null || true)" != "$COMMIT" ]; then
  rm -rf "$SRC"
  git init -q "$SRC"
  git -C "$SRC" fetch -q --depth 1 https://github.com/ggml-org/whisper.cpp "$COMMIT"
  git -C "$SRC" -c advice.detachedHead=false checkout -q FETCH_HEAD
fi
[ "$(git -C "$SRC" rev-parse HEAD)" = "$COMMIT" ] || { echo "whisper.cpp is not at $COMMIT" >&2; exit 1; }
# A tree somebody has edited is not the pinned one, whatever HEAD says — and
# this one lives on the Mac across runs, so build.sh's own check never sees it.
[ -z "$(git -C "$SRC" status --porcelain)" ] ||
  { echo "build/whisper.cpp on the Mac has local changes; delete it to refetch" >&2; exit 1; }

CMAKE="$(command -v cmake || true)"
if [ -z "$CMAKE" ]; then
  if [ ! -x "$HERE/cmake/CMake.app/Contents/bin/cmake" ]; then
    # Checked before it is unpacked, let alone run: everything else this build
    # fetches is pinned by hash, and a compiler driver is no place to stop.
    # The hash is Kitware's own, from cmake-3.30.5-SHA-256.txt.
    CMAKE_TGZ="$HERE/cmake-3.30.5-macos-universal.tar.gz"
    CMAKE_SHA256=3d603e507c7579b13518ef752b4ffcf3ed479fba80ee171d7d85da8153e869d0
    curl -fsSL -o "$CMAKE_TGZ" https://github.com/Kitware/CMake/releases/download/v3.30.5/cmake-3.30.5-macos-universal.tar.gz
    if [ "$(shasum -a 256 "$CMAKE_TGZ" | cut -d' ' -f1)" != "$CMAKE_SHA256" ]; then
      rm -f "$CMAKE_TGZ"
      echo "the CMake download does not match its sha256" >&2
      exit 1
    fi
    tar xzf "$CMAKE_TGZ"
    rm -f "$CMAKE_TGZ"
    mv cmake-3.30.5-macos-universal cmake
  fi
  CMAKE="$HERE/cmake/CMake.app/Contents/bin/cmake"
fi

# macOS 11 is the oldest Electron 34 runs on.
COMMON=(-DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0
        -DWHISPER_CPP_DIR="$SRC" -DWHISPER_CPP_COMMIT="$COMMIT")
X86_OFF=(-DGGML_SSE42=OFF -DGGML_AVX=OFF -DGGML_AVX2=OFF -DGGML_FMA=OFF -DGGML_F16C=OFF -DGGML_BMI2=OFF -DGGML_AVX512=OFF -DGGML_AVX_VNNI=OFF)
X86_AVX2=(-DGGML_SSE42=ON -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON -DGGML_BMI2=ON -DGGML_AVX512=OFF -DGGML_AVX_VNNI=OFF)

build() {
  local name="$1"; shift
  "$CMAKE" -S "$HERE" -B "$HERE/build/darwin-$name" "${COMMON[@]}" -DWHISPER_HELPER_VARIANT="$name" "$@" >/dev/null
  "$CMAKE" --build "$HERE/build/darwin-$name" --target whisper-helper -j"$(sysctl -n hw.ncpu)" >/dev/null
  echo "  link OK  darwin-$name"
}

build arm64 -DCMAKE_OSX_ARCHITECTURES=arm64
build x86_64 -DCMAKE_OSX_ARCHITECTURES=x86_64 "${X86_OFF[@]}"
# x86_64h cannot go in CMAKE_OSX_ARCHITECTURES: ggml decides which CPU's
# sources to compile from that name and does not know this one, so it would
# build none of its x86 kernels. Instead CMake is told it is targeting an x86_64
# Darwin, and the compiler and linker are told the real slice.
build x86_64h -DCMAKE_SYSTEM_NAME=Darwin -DCMAKE_SYSTEM_PROCESSOR=x86_64 \
  -DCMAKE_C_FLAGS="-arch x86_64h" -DCMAKE_CXX_FLAGS="-arch x86_64h" \
  -DCMAKE_EXE_LINKER_FLAGS="-arch x86_64h" "${X86_AVX2[@]}"

mkdir -p dist/darwin-universal
lipo -create build/darwin-arm64/whisper-helper build/darwin-x86_64/whisper-helper build/darwin-x86_64h/whisper-helper \
  -output dist/darwin-universal/whisper-helper
strip -x dist/darwin-universal/whisper-helper
# Ad hoc, because an arm64 binary that is not signed at all is killed on
# launch, and strip has just invalidated the linker's signature. The package
# signs it again with the Developer ID.
codesign --force -s - dist/darwin-universal/whisper-helper
lipo -info dist/darwin-universal/whisper-helper
