#!/usr/bin/env bash
# Tests the range the SoapySDR driver advertises to its host, and that its
# protocol version 4 decoder agrees with the server's encoder.
#
# getFrequencyRange() is the only place any UberSDR client tells its host how far the
# receiver tunes, and GQRX / CubicSDR / GNU Radio clamp their tuning UI to it — so a wrong
# answer here is exactly what makes 6 m unreachable on a 129.6 Msps receiver.
#
# Each case stands up a real HTTP server, builds the real driver, loads it through
# SoapySDR::Device::make and compares the advertised Range against what the receiver said.
set -uo pipefail

cd "$(dirname "$0")"
BUILD="${TMPDIR:-/tmp}/ubersdr-soapy-test"
PORT="${UBERSDR_TEST_PORT:-18732}"

# A previously installed copy of this driver registers the same "ubersdr" key and, being
# found first, would be the one every case below actually exercised — silently testing the
# old binary and passing or failing for the wrong reason. Point SoapySDR at an empty root
# so the only module in the search path is the one just built.
EMPTY_ROOT="$BUILD/empty-root"
mkdir -p "$EMPTY_ROOT"
export SOAPY_SDR_ROOT="$EMPTY_ROOT"
export SOAPY_SDR_PLUGIN_PATH="$BUILD"

FALLBACK_MIN=10000
FALLBACK_MAX=30000000

echo "== building driver and probe =="
cmake -S .. -B "$BUILD" >/dev/null || { echo "cmake configure failed"; exit 1; }
cmake --build "$BUILD" >/dev/null || { echo "driver build failed"; exit 1; }
g++ -O0 -o "$BUILD/probe_range" probe_range.cpp -lSoapySDR || { echo "probe build failed"; exit 1; }
g++ -std=c++11 -O2 -Wall -Wextra -o "$BUILD/pcmv4_conformance" pcmv4_conformance.cpp \
    || { echo "conformance build failed"; exit 1; }

pass=0; fail=0
server_pid=""

cleanup() { [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null; }
trap cleanup EXIT

# check <name> <json-body-or-dash> <want-min> <want-max>
check() {
    local name="$1" body="$2" want_min="$3" want_max="$4"
    local bodyfile="$BUILD/body.json"

    if [ "$body" = "-" ]; then
        bodyfile="-"
    else
        printf '%s' "$body" > "$bodyfile"
    fi

    python3 fixture_server.py "$PORT" "$bodyfile" &
    server_pid=$!
    # Wait for the socket rather than sleeping a guessed interval.
    for _ in $(seq 1 50); do
        python3 -c "import socket,sys; s=socket.socket(); sys.exit(0 if s.connect_ex(('127.0.0.1',$PORT))==0 else 1)" 2>/dev/null && break
        sleep 0.1
    done

    local got
    got=$("$BUILD/probe_range" "ws://127.0.0.1:$PORT/ws" 2>/dev/null)
    local rc=$?

    kill "$server_pid" 2>/dev/null; wait "$server_pid" 2>/dev/null; server_pid=""

    if [ $rc -ne 0 ]; then
        echo "FAIL $name: probe exited $rc"
        fail=$((fail+1)); return
    fi
    if [ "$got" = "$want_min $want_max" ]; then
        echo "PASS $name -> $got"
        pass=$((pass+1))
    else
        echo "FAIL $name: got '$got', want '$want_min $want_max'"
        fail=$((fail+1))
    fi
}

# The lossless decoder, against packets the SERVER's encoder produced.
#
# This is the one case that needs no server: testdata/pcmv4_stream.bin is a
# recorded stream and PCMV4_SHA256 is the hash of the samples that went into it.
# It matters more than it looks. The version 4 predictor is backward adaptive —
# the two ends derive their filter taps independently and never exchange a
# coefficient — so an arithmetic difference between this decoder and the Go one
# produces plausible noise rather than an error, and nothing short of comparing
# the samples would catch it. The stream covers ordinary mono audio, silent
# packets carrying no body, an escape to verbatim samples, a sample-rate change
# and the interleaved I/Q this driver actually uses.
#
# testdata/pcmv4_scaled.bin covers the reduced-depth IQ mode the min_margin
# device argument asks for: profile 2, where a shift byte leads the body and the
# samples come back shifted left by it. It runs the paths that exist only there
# -- a shift that changes with the margin, a silent packet that carries no shift
# at all, an escape that carries one, and the profile switching to plain IQ and
# back when the margin goes to lossless -- against samples the server's own
# encoder and decoder agreed on. Getting the shift wrong does not fail; it hands
# the host a signal several bits too quiet.
#
# testdata/pcmv4_rice_edge.bin covers what a recording of ordinary traffic will
# not: a Rice codeword whose unary run is exactly 63 bits long and is counted
# out of a full 64-bit accumulator, so the decoder shifts by 64. Go defines that
# as zero and C++ does not, and the difference is silent -- the accumulator
# keeps its bits, the packet decodes as noise, and the predictor adapts to the
# noise. It appeared roughly once every quarter of a million packets on live IQ,
# which is often enough to break a receiver in minutes and rare enough that a
# recorded fixture only holds one by luck.
PCMV4_SHA256=4875d2185f1ff5a2031386c569cac0c2259e6a827b9e61f813399a19c3b9c903
PCMV4_RICE_EDGE_SHA256=3413109ff6d06d44fb8fa44c84595b776f5570f05663b762830853ddc0183527
PCMV4_SCALED_SHA256=7315366ceed3e70552c28d31cde690a14dc66f5244b5a8dc34a5e696f5698ccc
echo "== cases =="
got=$("$BUILD/pcmv4_conformance" testdata/pcmv4_stream.bin 2>/dev/null | sha256sum | cut -d" " -f1)
if [ "$got" = "$PCMV4_SHA256" ]; then
    echo "PASS pcmv4-conformance"; pass=$((pass+1))
else
    echo "FAIL pcmv4-conformance: decoded samples hash to $got, want $PCMV4_SHA256"; fail=$((fail+1))
fi

got=$("$BUILD/pcmv4_conformance" testdata/pcmv4_rice_edge.bin 2>/dev/null | sha256sum | cut -d" " -f1)
if [ "$got" = "$PCMV4_RICE_EDGE_SHA256" ]; then
    echo "PASS pcmv4-rice-edge"; pass=$((pass+1))
else
    echo "FAIL pcmv4-rice-edge: decoded samples hash to $got, want $PCMV4_RICE_EDGE_SHA256"; fail=$((fail+1))
fi

got=$("$BUILD/pcmv4_conformance" testdata/pcmv4_scaled.bin 2>/dev/null | sha256sum | cut -d" " -f1)
if [ "$got" = "$PCMV4_SCALED_SHA256" ]; then
    echo "PASS pcmv4-scaled"; pass=$((pass+1))
else
    echo "FAIL pcmv4-scaled: decoded samples hash to $got, want $PCMV4_SCALED_SHA256"; fail=$((fail+1))
fi

# Unreachable server: nothing is listening on this port at all. The driver must still
# load and must advertise the pre-span range rather than refusing to construct.
got=$("$BUILD/probe_range" "ws://127.0.0.1:1/ws" 2>/dev/null)
if [ "$got" = "$FALLBACK_MIN $FALLBACK_MAX" ]; then
    echo "PASS unreachable-server -> $got"; pass=$((pass+1))
else
    echo "FAIL unreachable-server: got '$got', want '$FALLBACK_MIN $FALLBACK_MAX'"; fail=$((fail+1))
fi

# The endpoint 404s — an older server that predates /api/description.
check "no-endpoint" "-" "$FALLBACK_MIN" "$FALLBACK_MAX"

# The receiver we are actually here for: 129.6 Msps, 6 m in range.
check "60MHz-receiver" \
  '{"tuning_range":{"min_frequency":10000,"max_frequency":60000000,"spectrum_span_hz":60000000,"spectrum_center_hz":30000000,"input_samprate":129600000,"samprate_source":"radiod-conf"}}' \
  10000 60000000

# Today's receiver, unchanged.
check "30MHz-receiver" \
  '{"tuning_range":{"min_frequency":10000,"max_frequency":30000000,"spectrum_span_hz":30000000,"spectrum_center_hz":15000000,"input_samprate":64800000,"samprate_source":"radiod-conf"}}' \
  10000 30000000

# A server that publishes everything else but not the range.
check "no-tuning-range" \
  '{"receiver":{"callsign":"M0TST"},"chat_enabled":true}' \
  "$FALLBACK_MIN" "$FALLBACK_MAX"

# Each field falls back on its own: stating one must not reset the other.
check "max-only" \
  '{"tuning_range":{"max_frequency":60000000}}' \
  10000 60000000
check "min-only" \
  '{"tuning_range":{"min_frequency":50000}}' \
  50000 30000000

# Zero, null and empty string must all fall through rather than 0 becoming a limit.
check "zero-fields" \
  '{"tuning_range":{"min_frequency":0,"max_frequency":0}}' \
  "$FALLBACK_MIN" "$FALLBACK_MAX"
check "null-fields" \
  '{"tuning_range":{"min_frequency":null,"max_frequency":null}}' \
  "$FALLBACK_MIN" "$FALLBACK_MAX"
check "string-fields" \
  '{"tuning_range":{"min_frequency":"","max_frequency":"lots"}}' \
  "$FALLBACK_MIN" "$FALLBACK_MAX"

# An inverted range is a misconfigured receiver; adopting it would hand the host a
# backwards Range. Refused wholesale, both edges, not silently swapped.
check "inverted" \
  '{"tuning_range":{"min_frequency":60000000,"max_frequency":10000}}' \
  "$FALLBACK_MIN" "$FALLBACK_MAX"
check "degenerate" \
  '{"tuning_range":{"min_frequency":30000000,"max_frequency":30000000}}' \
  "$FALLBACK_MIN" "$FALLBACK_MAX"

# The field must be read out of tuning_range, not from whatever else in the payload
# happens to share the name. Here the decoy comes first and carries wrong numbers.
check "decoy-object-first" \
  '{"noise_floor":{"min_frequency":1,"max_frequency":2},"tuning_range":{"min_frequency":10000,"max_frequency":60000000}}' \
  10000 60000000

# Malformed JSON must not be adopted or crash the driver.
check "malformed" \
  '{"tuning_range":{"min_frequency":10000,' \
  "$FALLBACK_MIN" "$FALLBACK_MAX"

echo
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
