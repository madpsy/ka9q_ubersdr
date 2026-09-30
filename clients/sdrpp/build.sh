#!/usr/bin/env bash
# build.sh — build the UberSDR source module for SDR++ on every platform SDR++
# ships for, check each against the real SDR++ releases, and package them.
#
# What comes out, in dist/:
#
#   ubersdr-sdrpp-linux-x86_64.zip    ubersdr_source.so    (Ubuntu Focal / Debian Bullseye and newer)
#   ubersdr-sdrpp-linux-aarch64.zip   ubersdr_source.so    (the same, 64-bit ARM: Raspberry Pi OS 64-bit ...)
#   ubersdr-sdrpp-macos.zip           ubersdr_source.dylib (universal: Apple silicon and Intel)
#   ubersdr-sdrpp-windows-x64.zip     ubersdr_source.dll
#
# One binary per platform serves both upstream SDR++ and SDR++ Community
# Edition. That is a claim about somebody else's binaries, so it is checked
# rather than assumed: every build is compared against the libraries in the
# current upstream nightly and in the pinned CE release, and refused if it
# needs a symbol either of them lacks. --test goes further and runs the module
# inside each of those cores against a live receiver.
#
# How each platform is built:
#   Linux    Docker, Ubuntu Focal (glibc 2.31), amd64 and arm64 (arm64 under emulation)
#   Windows  Docker, clang-cl against Microsoft's CRT and SDK fetched by xwin,
#            which accepts Microsoft's license terms for them
#   macOS    over ssh on $MAC_HOST, then signed with the Developer ID and
#            notarised, as clients/tui/notarise-mac.sh does: a downloaded,
#            unnotarised dylib is refused by Gatekeeper
#
# Usage:
#   ./build.sh                       build everything
#   ./build.sh --only=linux,windows  build some (linux, linux-arm, mac, windows)
#   ./build.sh --test                ...and run the live tests
#   ./build.sh --publish             ...and upload the zips to the `latest`
#                                    release, replacing what is there. Asks first.
#   ./build.sh --yes                 answer that prompt in advance
#
# Environment:
#   MAC_HOST            Mac to build and sign on (default: macbook)
#   UBERSDR_TEST_SERVER receiver for --test (default: https://m9psy-1.instance.ubersdr.org)
#   UBERSDR_TEST_MODE   IQ mode for --test (default: iq192)
#   SDRPP_CE_TAG        Community Edition release to check against (default: v1.2.5-CE)

set -euo pipefail
cd "$(dirname "$0")"
HERE="$PWD"
CLIENTS="$(cd .. && pwd)"

MAC_HOST="${MAC_HOST:-macbook}"
MAC_DIR="ubersdr-sdrpp-build"
REPO="${UBERSDR_REPO:-madpsy/ka9q_ubersdr}"
TAG="${UBERSDR_TAG:-latest}"
CE_TAG="${SDRPP_CE_TAG:-v1.2.5-CE}"
TEST_SERVER="${UBERSDR_TEST_SERVER:-https://m9psy-1.instance.ubersdr.org}"
TEST_MODE="${UBERSDR_TEST_MODE:-iq192}"
KEYCHAIN_PASSWORD_FILE="${MAC_KEYCHAIN_PASSWORD_FILE:-$HOME/keys/mac-keychain.password}"
APPLE_PASSWORD_FILE="${APPLE_PASSWORD_FILE:-$HOME/keys/app.password}"
APPLE_ID_VALUE="${APPLE_ID:-nathan@nsamail.uk}"
TEAM_ID="${APPLE_TEAM_ID:-B7CM4Z8JW8}"

UPSTREAM_URL="https://github.com/AlexandreRouma/SDRPlusPlus/releases/download/nightly"
CE_URL="https://github.com/LunaeMons/SDRPlusPlus_CommunityEdition/releases/download/$CE_TAG"

CACHE="$HERE/.cache"
DIST="$HERE/dist"
OUT="$HERE/build-release"

ONLY="linux,linux-arm,mac,windows"
TEST=0
PUBLISH=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --only=*) ONLY="${arg#--only=}" ;;
    --test) TEST=1 ;;
    --publish) PUBLISH=1 ;;
    --yes) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,45p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
want() { [[ ",$ONLY," == *",$1,"* ]]; }

FAILED=()
fail() { echo "FAILED: $*" >&2; FAILED+=("$*"); }

# --- SDR++ releases to check against ------------------------------------------------

fetch() { # url dest
  [ -s "$2" ] && return 0
  mkdir -p "$(dirname "$2")"
  echo "  fetching $(basename "$1")"
  curl -fsSL -o "$2.part" "$1" && mv "$2.part" "$2"
}

# Unpacks one SDR++ release into $CACHE/<flavour>/<platform>/.
unpack_release() { # flavour url-base asset platform
  local dir="$CACHE/$1/$4"
  [ -d "$dir" ] && return 0
  fetch "$2/$3" "$CACHE/dl/$1-$3"
  mkdir -p "$dir"
  case "$3" in
    *.deb) dpkg-deb -x "$CACHE/dl/$1-$3" "$dir" ;;
    *.zip) unzip -q "$CACHE/dl/$1-$3" -d "$dir" ;;
  esac
}

# The nightly moves, so its unpacked copy is refreshed once a day.
if [ -d "$CACHE/upstream" ] && [ -n "$(find "$CACHE/upstream" -maxdepth 0 -mmin +1440)" ]; then
  rm -rf "$CACHE/upstream" "$CACHE"/dl/upstream-*
fi

# The SDR++ package built for this machine's distribution, for the Linux test:
# the core has to load here, next to this system's VOLK, FFTW and GLFW.
host_deb() {
  . /etc/os-release
  echo "sdrpp_${ID}_${VERSION_CODENAME}_amd64.deb"
}

releases() {
  local plat asset
  for plat in "$@"; do
    case "$plat" in
      linux-x86_64)  asset=sdrpp_debian_bullseye_amd64.deb ;;
      linux-aarch64) asset=sdrpp_debian_bullseye_aarch64.deb ;;
      windows)       asset=sdrpp_windows_x64.zip ;;
      mac)           asset=sdrpp_macos_arm.zip ;;
      linux-host)    asset="$(host_deb)" ;;
    esac
    unpack_release upstream "$UPSTREAM_URL" "$asset" "$plat"
    unpack_release ce "$CE_URL" "$asset" "$plat"
  done
}

# --- Linux ---------------------------------------------------------------------------

build_linux() { # docker-platform arch-name
  local plat="linux-$2"
  echo
  echo "== $plat"
  releases "$plat"
  docker build -q --platform "$1" -t "ubersdr-sdrpp-linux:$2" -f docker/linux.Dockerfile docker >/dev/null
  mkdir -p "$OUT/$plat"
  rm -f "$OUT/$plat/ubersdr_source.so"
  if docker run --rm --platform "$1" \
      -v "$CLIENTS:/src:ro" \
      -v "$CACHE/upstream/$plat:/sdrpp/upstream:ro" -v "$CACHE/ce/$plat:/sdrpp/ce:ro" \
      -v "$OUT/$plat:/out" \
      "ubersdr-sdrpp-linux:$2" /src/sdrpp/docker/build-linux.sh 2>&1 \
      | grep -vE '^\[[0-9]+/[0-9]+\] Building C object'; then
    [ -s "$OUT/$plat/ubersdr_source.so" ] || fail "$plat: no module produced"
  else
    fail "$plat build"
  fi
}

# --- Windows -------------------------------------------------------------------------

build_windows() {
  echo
  echo "== windows-x64"
  releases windows
  docker build -q -t ubersdr-sdrpp-win -f docker/windows.Dockerfile docker >/dev/null
  mkdir -p "$OUT/windows"
  rm -f "$OUT/windows/ubersdr_source.dll"
  # Real directories, not symlinks: they are mounted into the container.
  local w="$CACHE/win-stage"
  rm -rf "$w"; mkdir -p "$w"
  cp -r "$(dirname "$(find "$CACHE/upstream/windows" -name sdrpp_core.dll | head -1)")" "$w/upstream"
  cp -r "$(dirname "$(find "$CACHE/ce/windows" -name sdrpp_core.dll | head -1)")" "$w/ce"
  if docker run --rm -e SDRPP_LINK=upstream \
      -v "$CLIENTS:/src:ro" -v "$w:/sdrpp:ro" -v "$OUT/windows:/out" \
      ubersdr-sdrpp-win /src/sdrpp/docker/build-windows.sh 2>&1 \
      | grep -vE '^\[[0-9]+/[0-9]+\] Building C object'; then
    [ -s "$OUT/windows/ubersdr_source.dll" ] || fail "windows: no module produced"
  else
    fail "windows build"
  fi
}

# --- macOS ---------------------------------------------------------------------------

mac() {
  ssh -o BatchMode=yes -o ConnectTimeout=15 "$MAC_HOST" \
      "export PATH=/opt/homebrew/bin:\$PATH; export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer; $*" \
      2> >(grep -v "X11 forwarding request failed" >&2)
}

# Same keychain handling as clients/tui/notarise-mac.sh: the signing key sits in
# the login keychain, which an ssh session may only use once unlocked.
mac_signed() {
  printf '%s\n' "$(cat "$KEYCHAIN_PASSWORD_FILE" 2>/dev/null)" "$(cat "$APPLE_PASSWORD_FILE" 2>/dev/null)" \
  | ssh -o BatchMode=yes "$MAC_HOST" "
      export PATH=/opt/homebrew/bin:\$PATH
      export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
      IFS= read -r pw || true
      IFS= read -r apppw || true
      kc=\$HOME/Library/Keychains/login.keychain-db
      if [ -n \"\$pw\" ]; then
        security unlock-keychain -p \"\$pw\" \$kc 2>/dev/null || true
        security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k \"\$pw\" \$kc >/dev/null 2>&1 || true
      fi
      unset pw
      $*
    " 2> >(grep -v "X11 forwarding request failed" >&2)
}

build_mac() {
  echo
  echo "== macos (universal)"
  mkdir -p "$OUT/mac"
  rm -f "$OUT/mac/ubersdr_source.dylib" "$OUT/mac/ubersdr_source.dylib.gatekeeper-ok"
  if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$MAC_HOST" true 2>/dev/null; then
    fail "macos: cannot reach $MAC_HOST over ssh"
    return
  fi

  # CMake from Kitware's portable archive, kept in the build folder, so the
  # build installs nothing on the Mac.
  mac "mkdir -p ~/$MAC_DIR && cd ~/$MAC_DIR && rm -rf src && mkdir -p src/clients \
       && ( [ -x cmake/CMake.app/Contents/bin/cmake ] || ( curl -fsSL https://github.com/Kitware/CMake/releases/download/v3.30.5/cmake-3.30.5-macos-universal.tar.gz | tar xz && mv cmake-3.30.5-macos-universal cmake ) )"
  ( cd "$CLIENTS" && tar czf - sdrpp/CMakeLists.txt sdrpp/src sdrpp/compat sdrpp/test soapy_driver/pcm_v4.hpp ) \
    | mac "cd ~/$MAC_DIR/src/clients && tar xzf -"

  if ! mac "cd ~/$MAC_DIR && C=cmake/CMake.app/Contents/bin/cmake \
        && \$C -S src/clients/sdrpp -B build -DCMAKE_BUILD_TYPE=Release '-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64' -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0 >/dev/null 2>&1 \
        && \$C --build build --target ubersdr_source -j8 2>&1 | grep -E 'error' ; \
        strip -x build/ubersdr_source.dylib && lipo -info build/ubersdr_source.dylib"; then
    fail "macos build"
    return
  fi

  # Sign and notarise. A dylib cannot have a ticket stapled to it, so Gatekeeper
  # checks with Apple when it is first loaded; "Accepted" is what matters.
  local cert
  cert="$(mac "security find-identity -v -p codesigning 2>/dev/null | grep -m1 'Developer ID Application' | sed 's/.*\"\(.*\)\".*/\1/'" || true)"
  local verdict=""
  if [ -z "$cert" ] || [ ! -f "$APPLE_PASSWORD_FILE" ]; then
    echo "  not signed: no Developer ID certificate on $MAC_HOST, or no $APPLE_PASSWORD_FILE"
  else
    verdict="$(mac_signed "cd ~/$MAC_DIR/build \
        && codesign --force --timestamp --options runtime --sign '$cert' ubersdr_source.dylib \
        && codesign --verify --strict ubersdr_source.dylib \
        && rm -f notarise.zip && ditto -c -k ubersdr_source.dylib notarise.zip \
        && xcrun notarytool submit notarise.zip --apple-id '$APPLE_ID_VALUE' --team-id '$TEAM_ID' --password \"\$apppw\" --wait 2>&1 \
           | grep -E '^\s*status:' | tail -1" || true)"
    echo "  signed with $cert; notarisation:${verdict#*status:}"
  fi
  scp -q -o BatchMode=yes "$MAC_HOST:$MAC_DIR/build/ubersdr_source.dylib" "$OUT/mac/" 2>/dev/null \
    || { fail "macos: could not copy the dylib back"; return; }
  if [[ "$verdict" == *Accepted* ]]; then
    echo "Accepted by Apple notary service $(date -u +%FT%TZ)" > "$OUT/mac/ubersdr_source.dylib.gatekeeper-ok"
  fi
}

# --- tests ---------------------------------------------------------------------------

test_linux() {
  echo
  echo "== test linux-x86_64 against $TEST_SERVER ($TEST_MODE)"
  # The test programs link a real core and include the core's signal path, so
  # they are built on this machine against its VOLK and FFTW headers, then
  # run with each release's own libraries.
  local tb="$HERE/build-test"
  releases linux-host
  cmake -S "$HERE" -B "$tb" -G Ninja -DCMAKE_BUILD_TYPE=Release \
        -DUBERSDR_TEST_CORE_LIB="$(find "$CACHE/upstream/linux-host" -name libsdrpp_core.so | head -1)" >"$tb.log" 2>&1 \
    && cmake --build "$tb" --target host_test live_test >>"$tb.log" 2>&1 \
    || { tail -20 "$tb.log"; fail "linux test build (needs libvolk-dev and libfftw3-dev)"; return; }
  local f lib root rc
  for f in upstream ce; do
    lib="$(dirname "$(find "$CACHE/$f/linux-host" -name libsdrpp_core.so | head -1)")"
    root="$(mktemp -d)"
    echo "  -- $f"
    rc=0
    HOST_TEST_CLICK=1 LD_LIBRARY_PATH="$lib" timeout 120 "$tb/host_test" "$OUT/linux-x86_64/ubersdr_source.so" "$root" \
        "$TEST_SERVER" "$TEST_MODE" 5 > "$root/log.txt" 2>&1 || rc=$?
    grep -E "registering|click sweep|receiver info|Assert|fft frames|PASS|FAIL|teardown" "$root/log.txt" | sed 's/^/    /'
    [ "$rc" = 0 ] || fail "linux $f host test (exit $rc)"
    rm -rf "$root"
  done
}

test_windows() {
  echo
  echo "== test windows-x64 under wine against $TEST_SERVER ($TEST_MODE)"
  command -v wine >/dev/null || { echo "  skipped: wine not installed"; return; }
  local w="$CACHE/win-stage" tinc="$HERE/.cache/testinc" out="$HERE/build-test-win"
  mkdir -p "$tinc" "$out"
  [ -f "$tinc/fftw3.h" ] || { cp -r /usr/include/volk "$tinc/" && cp /usr/include/fftw3.h "$tinc/"; } \
    || { echo "  skipped: needs VOLK and FFTW headers (libvolk-dev, libfftw3-dev)"; return; }
  docker run --rm -e SDRPP_LINK=upstream -v "$CLIENTS:/src:ro" -v "$w:/sdrpp:ro" -v "$tinc:/testinc:ro" \
      -v "$out:/out" ubersdr-sdrpp-win /src/sdrpp/docker/test-windows.sh >/dev/null 2>&1 \
    || { fail "windows test build"; return; }
  export WINEPREFIX="$HERE/.cache/wineprefix" WINEDEBUG=-all
  # SDR++ is built against MSVC 14.40+, whose std::mutex needs the runtime it
  # ships; wine's built-in msvcp140 is older and deadlocks in it.
  export WINEDLLOVERRIDES="msvcp140=n,b;vcruntime140=n,b;vcruntime140_1=n,b;concrt140=n,b"
  [ -d "$WINEPREFIX" ] || timeout 300 wineboot -i >/dev/null 2>&1 || true
  local f run rc
  for f in upstream ce; do
    run="$HERE/.cache/wine-run/$f"
    rm -rf "$run"; mkdir -p "$run/root"
    cp -r "$w/$f/." "$run/"
    cp "$OUT/windows/ubersdr_source.dll" "$out/host_test.exe" "$run/"
    echo "  -- $f"
    rc=0
    ( cd "$run" && HOST_TEST_CLICK=1 timeout 180 wine host_test.exe "Z:$(echo "$run/ubersdr_source.dll" | tr / '\\')" \
        "Z:$(echo "$run/root" | tr / '\\')" "$TEST_SERVER" "$TEST_MODE" 5 > log.txt 2>&1 ) || rc=$?
    grep -E "registering|click sweep|receiver info|Assert|fft frames|PASS|FAIL|teardown" "$run/log.txt" | sed 's/^/    /'
    [ "$rc" = 0 ] || fail "windows $f host test (exit $rc)"
  done
}

test_mac() {
  echo
  echo "== test macos against $TEST_SERVER ($TEST_MODE)"
  [ -s "$OUT/mac/ubersdr_source.dylib" ] || { echo "  skipped: no dylib"; return; }
  local tinc="$HERE/.cache/testinc"
  mkdir -p "$tinc"
  [ -f "$tinc/fftw3.h" ] || { cp -r /usr/include/volk "$tinc/" && cp /usr/include/fftw3.h "$tinc/"; }
  ( cd "$HERE/.cache" && tar czf - testinc ) | mac "cd ~/$MAC_DIR && tar xzf -"
  local f
  for f in upstream ce; do
    local url
    if [ "$f" = upstream ]; then url="$UPSTREAM_URL/sdrpp_macos_arm.zip"; else url="$CE_URL/sdrpp_macos_arm.zip"; fi
    echo "  -- $f"
    # The signed dylib, quarantined as a browser would leave it, so the test
    # also shows Gatekeeper letting it load.
    mac "cd ~/$MAC_DIR && ( [ -d sdrpp-$f ] || ( curl -fsSL -o sdrpp-$f.zip '$url' && mkdir sdrpp-$f && unzip -q sdrpp-$f.zip -d sdrpp-$f ) ) \
        && F=\$(dirname \$(find \$PWD/sdrpp-$f -name libsdrpp_core.dylib | head -1)) \
        && C=cmake/CMake.app/Contents/bin/cmake \
        && \$C -S src/clients/sdrpp -B build-test-$f -DCMAKE_BUILD_TYPE=Release -DUBERSDR_TEST_CORE_LIB=\$F/libsdrpp_core.dylib \
             -DUBERSDR_TEST_VOLK=\$(ls \$F/libvolk*.dylib | head -1) -DUBERSDR_TEST_EXTRA_INCLUDE=\$PWD/testinc >/dev/null 2>&1 \
        && \$C --build build-test-$f --target host_test -j8 >/dev/null 2>&1 \
        && rm -rf q && mkdir -p q/root && cp build/ubersdr_source.dylib q/ \
        && xattr -w com.apple.quarantine '0083;00000000;Safari;' q/ubersdr_source.dylib \
        && HOST_TEST_CLICK=1 DYLD_LIBRARY_PATH=\$F ./build-test-$f/host_test \$PWD/q/ubersdr_source.dylib \$PWD/q/root '$TEST_SERVER' '$TEST_MODE' 5 2>&1 \
           | grep -E 'registering|click sweep|receiver info|Assert|fft frames|PASS|FAIL|teardown|rror'" \
      || fail "macos $f host test"
  done
}

# --- packaging and publishing --------------------------------------------------------

package() { # platform-dir zip-name file
  local src="$OUT/$1/$3"
  [ -s "$src" ] || return 0
  local stage
  stage="$(mktemp -d)"
  cp "$src" "$stage/"
  cp "$HERE/INSTALL.txt" "$stage/"
  rm -f "$DIST/$2"
  ( cd "$stage" && zip -q -X "$DIST/$2" "$3" INSTALL.txt )
  rm -rf "$stage"
  if [ "$1" = mac ] && [ -f "$src.gatekeeper-ok" ]; then cp "$src.gatekeeper-ok" "$DIST/$2.gatekeeper-ok"; fi
  echo "  $2   $(du -h "$DIST/$2" | cut -f1)"
}

publish_release() {
  command -v gh >/dev/null 2>&1 || { echo "not published: gh not found" >&2; return; }
  gh auth status >/dev/null 2>&1 || { echo "not published: gh is not logged in" >&2; return; }
  gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 || { echo "not published: no '$TAG' release on $REPO" >&2; return; }

  local uploads=() z
  for z in "$DIST"/ubersdr-sdrpp-*.zip; do
    [ -e "$z" ] || continue
    if [[ "$z" == *macos* ]] && [ ! -f "$z.gatekeeper-ok" ]; then
      echo "  not uploading $(basename "$z"): not notarised, and Gatekeeper would refuse it"
      continue
    fi
    uploads+=("$z")
  done
  [ "${#uploads[@]}" -gt 0 ] || { echo "nothing to publish"; return; }

  echo "  Upload to https://github.com/$REPO/releases/tag/$TAG, replacing what is there:"
  for z in "${uploads[@]}"; do echo "      $(basename "$z")   $(du -h "$z" | cut -f1)"; done
  if [ "$ASSUME_YES" -eq 1 ]; then
    echo "  --yes given; uploading."
  elif [ ! -t 0 ]; then
    echo "not published: --publish asks first and there is no terminal. Pass --yes." >&2
    return
  else
    local reply=''
    read -r -p "  type 'yes' to upload: " reply || true
    [ "$reply" = yes ] || { echo "  not published."; return; }
  fi
  gh release upload "$TAG" "${uploads[@]}" --clobber --repo "$REPO" && echo "  published."
}

# --- main ----------------------------------------------------------------------------

mkdir -p "$CACHE" "$DIST" "$OUT"
want linux && build_linux linux/amd64 x86_64
want linux-arm && build_linux linux/arm64 aarch64
want windows && build_windows
want mac && build_mac

if [ "$TEST" -eq 1 ]; then
  want linux && [ -s "$OUT/linux-x86_64/ubersdr_source.so" ] && test_linux
  want windows && [ -s "$OUT/windows/ubersdr_source.dll" ] && test_windows
  want mac && test_mac
fi

echo
echo "== packages in $DIST"
want linux && package linux-x86_64 ubersdr-sdrpp-linux-x86_64.zip ubersdr_source.so
want linux-arm && package linux-aarch64 ubersdr-sdrpp-linux-aarch64.zip ubersdr_source.so
want mac && package mac ubersdr-sdrpp-macos.zip ubersdr_source.dylib
want windows && package windows ubersdr-sdrpp-windows-x64.zip ubersdr_source.dll

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo
  echo "Failures:"
  printf '  %s\n' "${FAILED[@]}"
  [ "$PUBLISH" -eq 1 ] && echo "Not publishing a build with failures."
  exit 1
fi
[ "$PUBLISH" -eq 1 ] && publish_release
exit 0
