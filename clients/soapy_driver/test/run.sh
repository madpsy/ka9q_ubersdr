#!/usr/bin/env bash
# Tests the range the SoapySDR driver advertises to its host.
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

# Unreachable server: nothing is listening on this port at all. The driver must still
# load and must advertise the pre-span range rather than refusing to construct.
echo "== cases =="
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
