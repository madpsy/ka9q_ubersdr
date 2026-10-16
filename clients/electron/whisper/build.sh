#!/usr/bin/env bash
# build.sh — build whisper-helper, the desktop client's on-device speech-to-text,
# for every platform the client ships on, and fetch the models it runs.
#
# What comes out, in dist/:
#
#   linux-x64/whisper-helper           any x86-64; hands over to the one below
#   linux-x64/whisper-helper-avx2      when the CPU has AVX2 (see "CPU dispatch"
#   win-x64/whisper-helper.exe         in whisper_helper.cpp: without AVX2,
#   win-x64/whisper-helper-avx2.exe    Whisper is six times slower)
#   linux-arm64/whisper-helper
#   darwin-universal/whisper-helper    arm64 + x86_64h + x86_64 in one file
#   models/ggml-base-q5_1.bin          the bundled multilingual model
#   models/ggml-silero-v6.2.0.bin      the voice-activity model
#
# And, only when asked for (--only=wasm), the same session for a browser:
#
#   ../../../static/v2/whisper/whisper-stt.{js,wasm}
#                                      whisper_session.cpp in WebAssembly, for
#                                      the v2 page where no app brings a
#                                      recogniser (see wasm/whisper_wasm.cpp).
#                                      Committed with the page; built in the
#                                      pinned emscripten/emsdk image.
#
# Every binary is static — the Linux ones fully, against glibc, so there is no
# glibc version to match against the oldest distribution the AppImage reaches;
# the Windows ones with libstdc++, libgcc and winpthread linked in; the Mac's
# against nothing but libSystem. The package carries a directory of them and
# nothing else.
#
# whisper.cpp is fetched at one commit, by hash, into build/whisper.cpp — git
# checks the hash against the content, so what is built is what was pinned —
# and not vendored here. The models are pinned in models.json by URL, size and
# sha256; a download that differs in either is refused.
#
# How each platform is built:
#   linux-x64, linux-arm64, win-x64
#            Docker, Debian trixie (see Dockerfile): native gcc, the aarch64
#            cross gcc, mingw-w64. Cross-compiled, not emulated: there is
#            nothing to run during the build.
#   darwin   over ssh on $MAC_HOST, with Xcode's clang (build-darwin.sh). Not
#            signed with the Developer ID here: the client's own build-mac.sh
#            signs everything in the app when it packages it.
#
# Usage:
#   ./build.sh                       everything
#   ./build.sh --only=linux-x64,models
#                                    some of: linux-x64, linux-arm64, win-x64,
#                                    darwin, models, wasm
#   ./build.sh --test                ...then test/run.sh against linux-x64
#
# Environment:
#   MAC_HOST                Mac to build on (default: macbook)
#   UBERSDR_WHISPER_IMAGE   the build image's tag (default: ubersdr-whisper-build:trixie)
#   UBERSDR_EMSDK_IMAGE     the WebAssembly build's (default: emscripten/emsdk:4.0.10)
set -euo pipefail
cd "$(dirname "$0")"
HERE="$PWD"

# whisper.cpp master on 12 October 2026, the version every measurement in
# whisper_helper.cpp and models.json was taken with. A tag would read better
# but was not near it; a hash is what git fetch can verify anyway.
WHISPER_CPP_COMMIT=0c7be696371069e0baa2515ed7aa08d5a5473aa6
WHISPER_CPP_REPO=https://github.com/ggml-org/whisper.cpp

MAC_HOST="${MAC_HOST:-macbook}"
MAC_DIR="ubersdr-whisper-build"
IMAGE="${UBERSDR_WHISPER_IMAGE:-ubersdr-whisper-build:trixie}"
EMSDK_IMAGE="${UBERSDR_EMSDK_IMAGE:-emscripten/emsdk:4.0.10}"

ONLY="linux-x64,linux-arm64,win-x64,darwin,models"
TEST=0
for arg in "$@"; do
  case "$arg" in
    --only=*) ONLY="${arg#--only=}" ;;
    --test) TEST=1 ;;
    -h|--help) sed -n '2,55p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
want() { [[ ",$ONLY," == *",$1,"* ]]; }
fail() { echo "FAILED: $*" >&2; exit 1; }

mkdir -p build dist

# ── Sources ──────────────────────────────────────────────────────────────────

fetch_whisper() {
  local src=build/whisper.cpp
  if [ "$(git -C "$src" rev-parse HEAD 2>/dev/null || true)" != "$WHISPER_CPP_COMMIT" ]; then
    echo "fetching whisper.cpp ${WHISPER_CPP_COMMIT:0:7} …"
    rm -rf "$src"
    git init -q "$src"
    git -C "$src" fetch -q --depth 1 "$WHISPER_CPP_REPO" "$WHISPER_CPP_COMMIT"
    git -C "$src" -c advice.detachedHead=false checkout -q FETCH_HEAD
  fi
  [ "$(git -C "$src" rev-parse HEAD)" = "$WHISPER_CPP_COMMIT" ] || fail "whisper.cpp is not at $WHISPER_CPP_COMMIT"
  # A tree somebody has edited is not the pinned one, whatever HEAD says.
  [ -z "$(git -C "$src" status --porcelain)" ] || fail "build/whisper.cpp has local changes; delete it to refetch"
}

# ── Models ───────────────────────────────────────────────────────────────────

# models.json's entries as "key file url size sha256 bundled" lines. Node reads
# the JSON because the desktop client cannot be built without it anyway.
model_list() {
  node -e '
    const m = require(process.argv[1]);
    for (const [k, v] of Object.entries(m)) {
      if (k.startsWith("//")) continue;
      console.log([k, v.file, v.url, v.size, v.sha256, v.bundled ? 1 : 0].join(" "));
    }' "$HERE/models.json"
}

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

fetch_models() {
  mkdir -p build/models dist/models
  local key file url size sum bundled
  while read -r key file url size sum bundled; do
    [ "$bundled" = 1 ] || continue
    local cached="build/models/$file"
    if [ ! -f "$cached" ] || [ "$(stat -c %s "$cached" 2>/dev/null || stat -f %z "$cached")" != "$size" ] \
        || [ "$(sha256 "$cached")" != "$sum" ]; then
      echo "fetching $file …"
      curl -fL --retry 3 --progress-bar -o "$cached.part" "$url" || fail "download of $file"
      mv "$cached.part" "$cached"
    fi
    local got
    got="$(sha256 "$cached")"
    [ "$got" = "$sum" ] || { rm -f "$cached"; fail "$file: sha256 $got, expected $sum"; }
    cp "$cached" "dist/models/$file"
    echo "  dist/models/$file  $(du -h "dist/models/$file" | cut -f1)  sha256 OK"
  done < <(model_list)
}

# ── Linux and Windows, in Docker ─────────────────────────────────────────────

docker_ready() {
  command -v docker >/dev/null 2>&1 || fail "docker is required for $1"
  docker info >/dev/null 2>&1 || fail "docker is not usable — daemon running? in the docker group?"
  docker build -q -t "$IMAGE" -f Dockerfile . >/dev/null || fail "building the $IMAGE image"
}

# The artefacts must come out newer than this, or the build did not write them,
# whatever the container's exit status said.
STAMP="$(mktemp)"
trap 'rm -f "$STAMP"' EXIT

check() {
  local f="$1" kind="$2"
  [ "$f" -nt "$STAMP" ] || fail "$f was not rebuilt"
  # A wrong-architecture binary is a correctly named file nobody can run.
  file "$f" | grep -Eq "$kind" || fail "$f is not what it should be: $(file -b "$f")"
  echo "  $f  $(du -h "$f" | cut -f1)  $(file -b "$f" | cut -c1-60)"
}

build_docker() {
  local target="$1"
  echo "building $target ($IMAGE) …"
  if ! docker run --rm \
      -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
      -v "$HERE:/w" -w /w "$IMAGE" \
      bash /w/build-inside.sh "$target" "$WHISPER_CPP_COMMIT" >"dist/build-$target.log" 2>&1; then
    tail -25 "dist/build-$target.log" >&2
    fail "$target build (whole log: dist/build-$target.log)"
  fi
}

# ── macOS, over ssh ──────────────────────────────────────────────────────────

# One remote command, with the PATH and DEVELOPER_DIR a non-interactive ssh
# session does not get.
mac() {
  ssh -o BatchMode=yes -o ConnectTimeout=15 "$MAC_HOST" \
      "export PATH=/opt/homebrew/bin:\$PATH; export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer; $*" \
      2> >(grep -v "X11 forwarding request failed" >&2)
}

build_darwin() {
  echo "building darwin on $MAC_HOST …"
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$MAC_HOST" true 2>/dev/null \
    || fail "cannot reach $MAC_HOST over ssh without a password"
  mac "mkdir -p ~/$MAC_DIR" >/dev/null
  tar czf - CMakeLists.txt whisper_helper.cpp whisper_session.cpp whisper_session.h whisper_core.cpp whisper_core.h build-darwin.sh \
    | mac "cd ~/$MAC_DIR && tar xzf -"
  if ! mac "cd ~/$MAC_DIR && bash build-darwin.sh $WHISPER_CPP_COMMIT" >"dist/build-darwin.log" 2>&1; then
    tail -25 dist/build-darwin.log >&2
    fail "darwin build (whole log: dist/build-darwin.log)"
  fi
  mkdir -p dist/darwin-universal
  mac "cat ~/$MAC_DIR/dist/darwin-universal/whisper-helper" >dist/darwin-universal/whisper-helper.part
  mv dist/darwin-universal/whisper-helper.part dist/darwin-universal/whisper-helper
  chmod +x dist/darwin-universal/whisper-helper
  # A smoke test where it can run: each slice says which variant it is. The
  # x86 slices run on an Apple-silicon Mac only under Rosetta, which is not
  # installed by default.
  mac "cd ~/$MAC_DIR && ./dist/darwin-universal/whisper-helper --version \
       && if arch -x86_64 /usr/bin/true 2>/dev/null; then arch -x86_64 ./dist/darwin-universal/whisper-helper --version; \
          else echo 'no Rosetta on this Mac: the x86_64 and x86_64h slices were not run'; fi" \
    | sed 's/^/  on the Mac: /' || true
}

# ── Main ─────────────────────────────────────────────────────────────────────

want models && fetch_models
if want linux-x64 || want linux-arm64 || want win-x64; then
  fetch_whisper
  docker_ready "the Linux and Windows builds"
fi
if want linux-x64; then
  build_docker linux-x64
  check dist/linux-x64/whisper-helper "ELF 64-bit LSB.*x86-64.*statically linked"
  check dist/linux-x64/whisper-helper-avx2 "ELF 64-bit LSB.*x86-64.*statically linked"
fi
if want linux-arm64; then
  build_docker linux-arm64
  check dist/linux-arm64/whisper-helper "ELF 64-bit LSB.*ARM aarch64.*statically linked"
fi
if want win-x64; then
  build_docker win-x64
  check dist/win-x64/whisper-helper.exe "PE32\+ executable.*x86-64"
  check dist/win-x64/whisper-helper-avx2.exe "PE32\+ executable.*x86-64"
fi
if want darwin; then
  build_darwin
  check dist/darwin-universal/whisper-helper "Mach-O universal binary with 3 architectures"
fi

if want wasm; then
  fetch_whisper
  command -v docker >/dev/null 2>&1 || fail "docker is required for the wasm build"
  echo "building wasm ($EMSDK_IMAGE) …"
  if ! docker run --rm -u "$(id -u):$(id -g)" -v "$HERE:/w" -w /w "$EMSDK_IMAGE" \
      bash /w/wasm/build-wasm.sh >"dist/build-wasm.log" 2>&1; then
    tail -25 dist/build-wasm.log >&2
    fail "wasm build (whole log: dist/build-wasm.log)"
  fi
  grep -q "Wasm detected" dist/build-wasm.log || fail "ggml did not build its WebAssembly kernels (see wasm/CMakeLists.txt)"
  check build/wasm/whisper-stt.wasm "WebAssembly"
  node wasm/embed.js "$WHISPER_CPP_COMMIT" "$EMSDK_IMAGE"
fi

if [ "$TEST" = 1 ]; then
  test/run.sh
fi
