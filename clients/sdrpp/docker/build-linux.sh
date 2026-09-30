#!/usr/bin/env bash
# Runs inside the ubersdr-sdrpp-linux image (see linux.Dockerfile).
#
#   /src     clients/ from the repo (sdrpp/ and soapy_driver/pcm_v4.hpp)
#   /sdrpp   SDR++ .deb packages for this architecture, unpacked, one per dir
#   /out     where ubersdr_source.so goes
set -euo pipefail

cmake -S /src/sdrpp -B /tmp/build -G Ninja -DCMAKE_BUILD_TYPE=Release >/tmp/configure.log 2>&1 \
    || { cat /tmp/configure.log; exit 1; }
cmake --build /tmp/build --target ubersdr_source
strip --strip-unneeded /tmp/build/ubersdr_source.so

cores=()
for d in /sdrpp/*/; do
    core="$(find "$d" -name libsdrpp_core.so | head -1)"
    [ -n "$core" ] && cores+=("$core")
done
[ "${#cores[@]}" -gt 0 ] || { echo "no libsdrpp_core.so under /sdrpp" >&2; exit 1; }
python3 /src/sdrpp/tools/elf_imports.py /tmp/build/ubersdr_source.so "${cores[@]}"

cp /tmp/build/ubersdr_source.so /out/
echo "built /out/ubersdr_source.so ($(uname -m))"
