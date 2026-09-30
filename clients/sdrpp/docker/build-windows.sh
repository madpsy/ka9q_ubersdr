#!/usr/bin/env bash
# Runs inside the ubersdr-sdrpp-win image (see windows.Dockerfile).
#
#   /src       clients/ from the repo (sdrpp/ and soapy_driver/pcm_v4.hpp)
#   /sdrpp     SDR++ Windows releases, unpacked: /sdrpp/<name>/sdrpp_core.dll ...
#              The first one listed in SDRPP_LINK provides the import libraries;
#              every one is checked for the symbols the module imports.
#   /out       where ubersdr_source.dll goes
set -euo pipefail

LINK_FROM="${SDRPP_LINK:?set SDRPP_LINK to the release dir to link against}"
IMPLIB=/tmp/implib
mkdir -p "$IMPLIB"

for dll in sdrpp_core volk; do
    python3 /src/sdrpp/tools/pe_imports.py def "/sdrpp/$LINK_FROM/$dll.dll" "$IMPLIB/$dll.def"
    llvm-dlltool -m i386:x86-64 -d "$IMPLIB/$dll.def" -l "$IMPLIB/$dll.lib" -D "$dll.dll"
done

cmake -S /src/sdrpp -B /tmp/build -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_TOOLCHAIN_FILE=/src/sdrpp/docker/windows-toolchain.cmake \
    -DSDRPP_WINDOWS_IMPORT_DIR="$IMPLIB" >/tmp/configure.log 2>&1 || { cat /tmp/configure.log; exit 1; }
cmake --build /tmp/build --target ubersdr_source

status=0
for dll in sdrpp_core volk; do
    targets=()
    for rel in /sdrpp/*/; do targets+=("$rel$dll.dll"); done
    python3 /src/sdrpp/tools/pe_imports.py check /tmp/build/ubersdr_source.dll "$dll.dll" "${targets[@]}" || status=1
done
[ "$status" -eq 0 ] || { echo "import check failed" >&2; exit 1; }

cp /tmp/build/ubersdr_source.dll /out/
echo "built /out/ubersdr_source.dll"
