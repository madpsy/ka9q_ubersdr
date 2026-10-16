#!/usr/bin/env bash
# build-wasm.sh — the half of ../build.sh --only=wasm that runs in the
# emscripten/emsdk container: whisper-stt.js and whisper-stt.wasm into
# /w/build/wasm. A file rather than a quoted `bash -c`, as build-inside.sh is,
# for the same reason (an apostrophe in a comment ends the quote).
set -euo pipefail
cd /w
OUT=build/wasm
rm -rf "$OUT"
emcmake cmake -S wasm -B "$OUT" -DCMAKE_BUILD_TYPE=Release -DWHISPER_CPP_DIR=/w/build/whisper.cpp
# Said in the configure log, and checked: without it ggml builds generic C, at
# half the speed (see CMakeLists.txt).
cmake --build "$OUT" -j"$(nproc)" --target whisper-stt

emcc --version | head -1
