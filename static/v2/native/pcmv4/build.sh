#!/usr/bin/env bash
# build.sh — build the WebAssembly PCM v4 decoder and embed it for the v2 bundle.
#
# Produces two modules from the same sources, one with WebAssembly SIMD and one
# without, and writes both into ../../src/radio/pcm-v4-wasm.generated.js as
# base64, so the v2 esbuild bundle picks them up as an ordinary import: no new
# loader flags, no .wasm file to serve, no route on the server.
#
# Needs only clang and wasm-ld (LLVM 18 is what this was written against) and
# node. No emscripten, no wasi-sysroot, no libc: the module is freestanding
# (shim.c) and imports nothing.
#
# The output is deterministic: the same sources and the same toolchain give the
# same bytes. Debug info is never generated, the linker strips names, and
# embed.js drops every custom section -- including "producers", which records
# the compiler version and is the only thing that would otherwise differ
# between two machines with the same code generator.
#
# Usage:
#   ./build.sh            build both modules and regenerate the JS
#   ./build.sh --check    build, and fail if the committed JS is out of date

set -euo pipefail

cd "$(dirname "$0")"

CHECK=0
for arg in "$@"; do
    case "$arg" in
        --check) CHECK=1 ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

find_tool() {
    for t in "$@"; do
        if command -v "$t" >/dev/null 2>&1; then command -v "$t"; return 0; fi
        if [[ -x "$t" ]]; then echo "$t"; return 0; fi
    done
    return 1
}

CC=$(find_tool clang-18 clang) || { echo "clang not found" >&2; exit 1; }
LD=$(find_tool wasm-ld wasm-ld-18 /usr/lib/llvm-18/bin/wasm-ld) || { echo "wasm-ld not found (apt-get install lld-18)" >&2; exit 1; }
command -v node >/dev/null || { echo "node not found" >&2; exit 1; }

SRCS=(api.c iq.c audio.c rice.c shim.c)
OUT=.build
mkdir -p "$OUT"

# -ffp-contract=off: the per-frame paths are a transcription of the JavaScript's
# double arithmetic and must round exactly where it does. WebAssembly has no
# scalar fused multiply-add today, but the flag says so rather than relying on it.
# -ffreestanding also stops the compiler turning shim.c's mem* loops into calls
# to themselves.
CFLAGS=(--target=wasm32 -O3 -g0 -ffreestanding -nostdlib -fno-builtin-memset -fno-builtin-memcpy
        -fno-builtin-memmove -ffp-contract=off -fno-math-errno -fvisibility=hidden
        -Wall -Wextra -Werror -Wno-unused-function)

# The scalar module is for engines without SIMD, which are also the oldest, so
# it is built for the MVP feature set. The SIMD one assumes what every engine
# with SIMD also has.
build() {
    local name=$1; shift
    local objs=()
    for src in "${SRCS[@]}"; do
        local obj="$OUT/${name}-${src%.c}.o"
        "$CC" "${CFLAGS[@]}" "$@" -c "$src" -o "$obj"
        objs+=("$obj")
    done
    # --stack-first puts the stack below the data, so an overflow traps on
    # address zero rather than silently overwriting static data.
    "$LD" --no-entry --strip-all --stack-first -z stack-size=65536 \
        --initial-memory=262144 -o "$OUT/pcmv4-${name}.raw.wasm" "${objs[@]}"
}

build simd -mcpu=generic -msimd128
build scalar -mcpu=mvp

GEN=../../src/radio/pcm-v4-wasm.generated.js
if [[ $CHECK -eq 1 ]]; then
    node embed.js "$OUT/pcmv4-simd.raw.wasm" "$OUT/pcmv4-scalar.raw.wasm" "$OUT/check.generated.js"
    if ! cmp -s "$OUT/check.generated.js" "$GEN"; then
        echo "$GEN is out of date: run ./build.sh" >&2
        exit 1
    fi
    echo "$GEN is up to date"
else
    node embed.js "$OUT/pcmv4-simd.raw.wasm" "$OUT/pcmv4-scalar.raw.wasm" "$GEN"
fi
