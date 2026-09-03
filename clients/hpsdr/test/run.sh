#!/usr/bin/env bash
# Tests the protocol version 4 decoder against packets the SERVER's encoder
# produced, and the openHPSDR protocol 1 wire logic against synthetic frames.
#
# This is the check that matters for this client. The version 4 predictor is
# backward adaptive — the two ends derive their filter taps independently and
# never exchange a coefficient — so an arithmetic difference between this C
# decoder and the Go one produces plausible noise rather than an error. An
# HPSDR client would report that only as a receiver that had gone deaf, and no
# amount of running the bridge would show it. Comparing the samples does.
#
# testdata/pcmv4_stream.bin is a recorded stream and EXPECTED_SHA256 is the hash
# of the samples that went into it. The stream covers what the format can do:
# ordinary mono audio, silent packets carrying no body, an escape to verbatim
# samples, a sample-rate change, and the interleaved I/Q this bridge uses.
#
# testdata/pcmv4_rice_edge.bin covers what a recording of ordinary traffic will
# not: a Rice codeword whose unary run is exactly 63 bits long and is counted
# out of a full 64-bit accumulator, so the decoder shifts by 64. Go defines that
# as zero and C does not, and the difference is silent -- the accumulator keeps
# its bits, the packet decodes as noise, and the predictor adapts to the noise.
# It appeared roughly once every quarter of a million packets on live IQ, which
# is often enough to break a receiver in minutes and rare enough that a recorded
# fixture only holds one by luck.
set -uo pipefail

cd "$(dirname "$0")"
BUILD="${TMPDIR:-/tmp}/ubersdr-hpsdr-test"
mkdir -p "$BUILD"

EXPECTED_SHA256=ba368c898ae406c5acc806653d9f2dbbfa40086eca3707fda5d77c13948f78d1
RICE_EDGE_SHA256=83e3d94b509efbf7a212a3e10193b3eb281fe1460cbfeef6aabe474c92a718c7

pass=0; fail=0

echo "== building =="
if ! gcc -std=gnu11 -Wall -Wextra -O2 -o "$BUILD/pcmv4_conformance" \
        pcmv4_conformance.c ../pcm_v4.c; then
    echo "FAIL build"; exit 1
fi
# Again with the sanitizers: this is hand-written C over attacker-shaped input
# — lengths and counts all come off the wire — so a decode that is merely
# correct on this fixture is not enough to know it is safe on a malformed one.
if ! gcc -std=gnu11 -Wall -Wextra -O1 -g -fsanitize=address,undefined \
        -o "$BUILD/pcmv4_conformance_asan" pcmv4_conformance.c ../pcm_v4.c; then
    echo "FAIL sanitizer build"; exit 1
fi

echo "== cases =="

got=$("$BUILD/pcmv4_conformance" testdata/pcmv4_stream.bin 2>/dev/null | sha256sum | cut -d" " -f1)
if [ "$got" = "$EXPECTED_SHA256" ]; then
    echo "PASS pcmv4-conformance"; pass=$((pass+1))
else
    echo "FAIL pcmv4-conformance: samples hash to $got, want $EXPECTED_SHA256"; fail=$((fail+1))
fi

got=$("$BUILD/pcmv4_conformance" testdata/pcmv4_rice_edge.bin 2>/dev/null | sha256sum | cut -d" " -f1)
if [ "$got" = "$RICE_EDGE_SHA256" ]; then
    echo "PASS pcmv4-rice-edge"; pass=$((pass+1))
else
    echo "FAIL pcmv4-rice-edge: samples hash to $got, want $RICE_EDGE_SHA256"; fail=$((fail+1))
fi

# The same fixture under the sanitizers, where the shift itself is the report
# rather than the samples it corrupted: UBSan names an over-wide shift exactly.
if "$BUILD/pcmv4_conformance_asan" testdata/pcmv4_rice_edge.bin >/dev/null 2>"$BUILD/asan_edge.log" &&
   ! grep -q "runtime error\|AddressSanitizer" "$BUILD/asan_edge.log"; then
    echo "PASS pcmv4-rice-edge-sanitizers"; pass=$((pass+1))
else
    echo "FAIL pcmv4-rice-edge-sanitizers"; sed 's/^/    /' "$BUILD/asan_edge.log" | head -20; fail=$((fail+1))
fi

if "$BUILD/pcmv4_conformance_asan" testdata/pcmv4_stream.bin >/dev/null 2>"$BUILD/asan.log"; then
    if grep -q "runtime error\|AddressSanitizer" "$BUILD/asan.log"; then
        echo "FAIL pcmv4-sanitizers"; sed 's/^/    /' "$BUILD/asan.log" | head -20; fail=$((fail+1))
    else
        echo "PASS pcmv4-sanitizers"; pass=$((pass+1))
    fi
else
    echo "FAIL pcmv4-sanitizers: decode failed"; sed 's/^/    /' "$BUILD/asan.log" | head -20; fail=$((fail+1))
fi

# A truncated packet must be refused rather than read past. Every length in the
# header comes off the wire, so this is the shape of input that would find a
# missing bounds check.
truncated=0
for cut in 1 2 3 5 8 16 40; do
    if head -c $((9 + cut)) testdata/pcmv4_stream.bin > "$BUILD/short.bin" &&
       ! "$BUILD/pcmv4_conformance_asan" "$BUILD/short.bin" >/dev/null 2>&1; then
        truncated=$((truncated+1))
    fi
done
if [ "$truncated" -eq 7 ]; then
    echo "PASS pcmv4-truncation"; pass=$((pass+1))
else
    echo "FAIL pcmv4-truncation: $truncated of 7 truncated fixtures refused"; fail=$((fail+1))
fi

# The protocol 1 command decode, which is the half that fails silently: a wrong
# sample-rate code or a mis-shifted register address does not crash, it hands
# the client a correctly framed picture of the wrong thing. Run under the
# sanitizers for the same reason the decoder is — every length comes off the
# wire.
echo
if ! gcc -std=gnu11 -Wall -Wextra -O1 -g -fsanitize=address,undefined -I.. \
        -o "$BUILD/p1_framing" p1_framing.c ../hpsdr_p1.c 2>"$BUILD/p1build.log"; then
    echo "FAIL p1-framing build"; sed 's/^/    /' "$BUILD/p1build.log" | head -20; fail=$((fail+1))
elif "$BUILD/p1_framing" >"$BUILD/p1.log" 2>&1; then
    p1pass=$(grep -c '^PASS ' "$BUILD/p1.log")
    echo "PASS p1-framing ($p1pass cases)"; pass=$((pass+1))
else
    echo "FAIL p1-framing"; grep '^FAIL ' "$BUILD/p1.log" | sed 's/^/    /' | head -10; fail=$((fail+1))
fi

echo
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
