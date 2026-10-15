#!/usr/bin/env bash
# build-inside.sh — the half of build.sh that runs in the container.
#
#   build-inside.sh <linux-x64|linux-arm64|win-x64> <whisper.cpp commit>
#
# A file rather than a quoted `bash -c` string, as in ../omnirig: an apostrophe
# in a comment inside a single-quoted script ends the quote, and the build goes
# on to exit 0 having built nothing.
set -euo pipefail
TARGET="$1"
COMMIT="$2"

# Everything written under /w/build and /w/dist must end up owned by whoever ran
# build.sh, on any exit — a root-owned tree cannot be cleaned by the next run.
give_back() {
  [ -n "${HOST_UID:-}" ] && chown -R "${HOST_UID}:${HOST_GID:-$HOST_UID}" "/w/dist/$TARGET" "/w/build/$TARGET"-* 2>/dev/null || true
}
trap give_back EXIT

# The x86 variants; see "CPU dispatch" in whisper_helper.cpp for why there are
# two. GGML_NATIVE is off in CMakeLists.txt, so nothing here depends on the CPU
# that builds it — and every option is spelt out, because ggml's defaults for
# them differ between a native build and a cross build.
X86_BASELINE="-DGGML_SSE42=OFF -DGGML_AVX=OFF -DGGML_AVX2=OFF -DGGML_FMA=OFF -DGGML_F16C=OFF -DGGML_BMI2=OFF -DGGML_AVX512=OFF -DGGML_AVX_VNNI=OFF -DWHISPER_HELPER_DISPATCH=ON"
# x86-64-v3, less MOVBE and LZCNT which ggml does not ask for: Haswell (2013)
# and Excavator onwards.
X86_AVX2="-DGGML_SSE42=ON -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON -DGGML_BMI2=ON -DGGML_AVX512=OFF -DGGML_AVX_VNNI=OFF"
# Every 64-bit ARM, the Raspberry Pi 3 and 4 included, which have no dot-product
# instructions.
ARM_BASELINE="-DGGML_CPU_ARM_ARCH=armv8-a"

case "$TARGET" in
  linux-x64)
    TOOLCHAIN=""
    VARIANTS="baseline avx2"
    EXE=whisper-helper
    STRIP=strip ;;
  linux-arm64)
    TOOLCHAIN="-DCMAKE_SYSTEM_NAME=Linux -DCMAKE_SYSTEM_PROCESSOR=aarch64 -DCMAKE_C_COMPILER=aarch64-linux-gnu-gcc -DCMAKE_CXX_COMPILER=aarch64-linux-gnu-g++"
    VARIANTS="baseline"
    EXE=whisper-helper
    STRIP=aarch64-linux-gnu-strip ;;
  win-x64)
    # -muse-unaligned-vector-move: gcc cannot align the Win64 stack beyond 16
    # bytes (GCC bug 54412) yet spills AVX registers to it with aligned moves,
    # which fault at random. The assembler rewrites every one as unaligned;
    # on anything since Nehalem the unaligned form costs nothing when the
    # address happens to be aligned.
    TOOLCHAIN="-DCMAKE_SYSTEM_NAME=Windows -DCMAKE_SYSTEM_PROCESSOR=x86_64 -DCMAKE_C_COMPILER=x86_64-w64-mingw32-gcc-posix -DCMAKE_CXX_COMPILER=x86_64-w64-mingw32-g++-posix -DCMAKE_RC_COMPILER=x86_64-w64-mingw32-windres -DCMAKE_C_FLAGS=-Wa,-muse-unaligned-vector-move -DCMAKE_CXX_FLAGS=-Wa,-muse-unaligned-vector-move"
    VARIANTS="baseline avx2"
    EXE=whisper-helper.exe
    STRIP=x86_64-w64-mingw32-strip ;;
  *) echo "unknown target: $TARGET" >&2; exit 2 ;;
esac

mkdir -p "/w/dist/$TARGET"
for v in $VARIANTS; do
  case "$TARGET:$v" in
    linux-arm64:baseline) FLAGS="$ARM_BASELINE" ;;
    *:baseline) FLAGS="$X86_BASELINE" ;;
    *:avx2) FLAGS="$X86_AVX2" ;;
  esac
  B="/w/build/$TARGET-$v"
  # shellcheck disable=SC2086 # the flag lists are meant to split
  cmake -S /w -B "$B" -DCMAKE_BUILD_TYPE=Release \
    -DWHISPER_CPP_DIR=/w/build/whisper.cpp -DWHISPER_CPP_COMMIT="$COMMIT" -DWHISPER_HELPER_VARIANT="$v" \
    $TOOLCHAIN $FLAGS
  cmake --build "$B" --target whisper-helper -j"$(nproc)"
  case "$v" in
    baseline) OUT="$EXE" ;;
    *) OUT="${EXE%.exe}-$v${EXE#whisper-helper}" ;;
  esac
  cp "$B/$EXE" "/w/dist/$TARGET/$OUT"
  $STRIP --strip-unneeded "/w/dist/$TARGET/$OUT"
  echo "  link OK  $TARGET/$OUT"
done
