#!/usr/bin/env bash
# Runs inside the ubersdr-sdrpp-win image: builds test/host_test and
# test/live_test as Windows executables, linked against the SDR++ release in
# /sdrpp/$SDRPP_LINK, into /out. They are then run under wine from the release
# directory, next to its DLLs (see build.sh --test).
#
#   /testinc   VOLK and FFTW headers (host_test includes the core's full signal
#              path, which needs their declarations; nothing from them is linked
#              beyond VOLK's allocator)
set -euo pipefail

LINK_FROM="${SDRPP_LINK:?}"
IMPLIB=/tmp/implib
mkdir -p "$IMPLIB"
for dll in sdrpp_core volk; do
    python3 /src/sdrpp/tools/pe_imports.py def "/sdrpp/$LINK_FROM/$dll.dll" "$IMPLIB/$dll.def"
done
# VOLK's real header declares its allocator with C linkage; the volk.dll SDR++
# ships exports it C++-mangled. Alias the C names onto the exports, for the test
# build only (the module itself declares them to match; see compat/volk/volk.h).
cat >>"$IMPLIB/volk.def" <<'EOF'
    volk_malloc == ?volk_malloc@@YAPEAX_K0@Z
    volk_free == ?volk_free@@YAXPEAX@Z
    volk_get_alignment == ?volk_get_alignment@@YA_KXZ
EOF
for dll in sdrpp_core volk; do
    llvm-dlltool -m i386:x86-64 -d "$IMPLIB/$dll.def" -l "$IMPLIB/$dll.lib" -D "$dll.dll"
done

cmake -S /src/sdrpp -B /tmp/wtbuild -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_TOOLCHAIN_FILE=/src/sdrpp/docker/windows-toolchain.cmake \
    -DSDRPP_WINDOWS_IMPORT_DIR="$IMPLIB" \
    -DUBERSDR_TEST_CORE_LIB="$IMPLIB/sdrpp_core.lib" -DUBERSDR_TEST_VOLK="$IMPLIB/volk.lib" \
    -DUBERSDR_TEST_EXTRA_INCLUDE=/testinc >/tmp/cfg.log 2>&1 || { cat /tmp/cfg.log; exit 1; }
cmake --build /tmp/wtbuild --target host_test live_test
cp /tmp/wtbuild/host_test.exe /tmp/wtbuild/live_test.exe /out/
echo "built /out/host_test.exe /out/live_test.exe"
