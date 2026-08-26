#!/bin/bash

# get-samprate.sh - Report the front end sample rate the running receiver is using,
#                   and the FFTW transform size that follows from it.
#
# Intended use: generate_wisdom.sh, which needs to know which transform radiod will
# actually plan so it generates wisdom for that one and not for the other.
#
# ── Where the answer comes from ───────────────────────────────────────────────
#
# The running server, via /api/description → tuning_range.input_samprate. That is the
# value UberSDR resolved at startup and is actually operating on, which is what matters
# here — a radiod .conf edited since the last restart says what the receiver *will* do,
# not what it is doing, and wisdom is for the transform being planned now.
#
# It also avoids re-implementing the config parser: [global] has its own samprate (the
# 12 kHz audio output rate) that must not be mistaken for the front end's, keys can
# repeat, values can carry k/m suffixes and inline comments. The server has already
# dealt with all of that.
#
# Falls back to reading the radiod .conf directly when the server is not reachable —
# during a first install, or while it is stopped — so this still answers on a machine
# that has never started UberSDR.
#
# ── Output ────────────────────────────────────────────────────────────────────
#
#   samprate   Front end sample rate in Hz, e.g. 64800000
#   blocktime  Forward FFT block time in seconds, e.g. 0.02
#   overlap    Forward FFT overlap factor, e.g. 5
#   fft_size   The transform radiod plans, e.g. 1620000
#   fft_name   The fftwf-wisdom name for it, e.g. rof1620000
#   source     "api" or "conf"
#
# Default output is shell-eval friendly (KEY=value). --fft prints just fft_name.
#
# Override the server address with UBERSDR_URL, e.g.
#   UBERSDR_URL=http://localhost:9090 ./get-samprate.sh

set -uo pipefail

UBERSDR_URL="${UBERSDR_URL:-http://localhost:8080}"
RADIOD_CONF="${RADIOD_CONF:-/etc/ka9q-radio/radiod@ubersdr.conf}"

MODE="env"
[ "${1:-}" = "--fft" ] && MODE="fft"
[ "${1:-}" = "--json" ] && MODE="json"

SAMPRATE=""
SOURCE=""

# ── 1. The running server ─────────────────────────────────────────────────────
# No jq: this is one integer out of a flat object, and get-cpu.sh sets the precedent
# that these helpers do not add a dependency for that.
_json=$(curl -s --max-time 5 "${UBERSDR_URL}/api/description" 2>/dev/null || true)
if [ -n "$_json" ]; then
    # Narrow to the tuning_range object first, so this cannot pick up the input_samprate
    # that also appears under "frontend" in the same document.
    _tr=$(printf '%s' "$_json" | sed -n 's/.*"tuning_range"[[:space:]]*:[[:space:]]*{\([^}]*\)}.*/\1/p')
    if [ -n "$_tr" ]; then
        SAMPRATE=$(printf '%s' "$_tr" | sed -n 's/.*"input_samprate"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p')
        [ -n "$SAMPRATE" ] && SOURCE="api"
    fi
fi

# ── 2. The radiod config, if the server is not up ─────────────────────────────
# Section-aware, last key wins — the same rules the server and radiod itself apply.
# Read the conf once, without sudo if we can. The file is normally world-readable and
# the server itself reads it unprivileged; sudo is only reached for when it is not, so a
# machine that does not need it never prompts.
_CONF_TEXT=""
_read_conf() {
    [ -n "$_CONF_TEXT" ] && return 0
    if [ -r "$RADIOD_CONF" ]; then
        _CONF_TEXT=$(cat "$RADIOD_CONF" 2>/dev/null)
    elif sudo -n true 2>/dev/null && sudo test -r "$RADIOD_CONF" 2>/dev/null; then
        _CONF_TEXT=$(sudo cat "$RADIOD_CONF" 2>/dev/null)
    fi
    [ -n "$_CONF_TEXT" ]
}

_conf_key() {
    # _conf_key <section> <key>
    _read_conf || return 1
    printf '%s\n' "$_CONF_TEXT" | awk -v want="$1" -v key="$2" '
        { sub(/#.*/, "") }                                  # strip comments
        /^[[:space:]]*\[/ {
            s = $0; gsub(/[][[:space:]]/, "", s)
            section = tolower(s); next
        }
        section == want {
            line = $0
            if (match(line, /^[[:space:]]*[A-Za-z0-9_-]+[[:space:]]*=/)) {
                k = substr(line, 1, RLENGTH - 1); gsub(/[[:space:]]/, "", k)
                if (tolower(k) == key) {
                    v = substr(line, RLENGTH + 1)
                    gsub(/[[:space:]]/, "", v)
                    if (v != "") found = v          # last one wins
                }
            }
        }
        END { if (found != "") print found }
    ' 2>/dev/null
}

# Expand the k/m/g suffixes parse_frequency() accepts.
_expand() {
    local v="${1,,}" mult=1
    case "$v" in
        *k) mult=1000;       v="${v%k}" ;;
        *m) mult=1000000;    v="${v%m}" ;;
        *g) mult=1000000000; v="${v%g}" ;;
    esac
    awk -v v="$v" -v m="$mult" 'BEGIN{ printf "%.0f", v * m }'
}

BLOCKTIME=""
OVERLAP=""
if _read_conf; then
    _hw=$(_conf_key global hardware)
    _hw="${_hw:-rx888}"
    if [ -z "$SAMPRATE" ]; then
        _raw=$(_conf_key "${_hw,,}" samprate)
        [ -z "$_raw" ] && _raw=$(_conf_key rx888 samprate)
        if [ -n "$_raw" ]; then
            SAMPRATE=$(_expand "$_raw")
            SOURCE="conf"
        fi
    fi
    BLOCKTIME=$(_conf_key global blocktime)
    OVERLAP=$(_conf_key global overlap)
fi

if [ -z "$SAMPRATE" ]; then
    echo "Error: could not determine the front end sample rate." >&2
    echo "       Tried ${UBERSDR_URL}/api/description and ${RADIOD_CONF}." >&2
    exit 1
fi

# ka9q-radio's defaults, used when the config does not say. blocktime is in seconds on
# current ka9q-radio; a legacy value in milliseconds is rewritten by the entrypoint
# before radiod sees it, but this may be reading the file before that has happened.
BLOCKTIME="${BLOCKTIME:-0.02}"
OVERLAP="${OVERLAP:-5}"
awk -v b="$BLOCKTIME" 'BEGIN{ exit !(b >= 1) }' && BLOCKTIME=$(awk -v b="$BLOCKTIME" 'BEGIN{ printf "%g", b/1000 }')

# The forward FFT: L = samprate x blocktime new samples per block, and the transform is
# N = L x overlap/(overlap-1). Real input, so fftwf-wisdom calls it rofN.
read -r FFT_SIZE <<EOF2
$(awk -v s="$SAMPRATE" -v b="$BLOCKTIME" -v o="$OVERLAP" \
    'BEGIN{ L = s * b; printf "%.0f", L * o / (o - 1) }')
EOF2

case "$MODE" in
    fft)  echo "rof${FFT_SIZE}" ;;
    json) printf '{"samprate":%s,"blocktime":%s,"overlap":%s,"fft_size":%s,"fft_name":"rof%s","source":"%s"}\n' \
              "$SAMPRATE" "$BLOCKTIME" "$OVERLAP" "$FFT_SIZE" "$FFT_SIZE" "$SOURCE" ;;
    *)    echo "samprate=${SAMPRATE}"
          echo "blocktime=${BLOCKTIME}"
          echo "overlap=${OVERLAP}"
          echo "fft_size=${FFT_SIZE}"
          echo "fft_name=rof${FFT_SIZE}"
          echo "source=${SOURCE}" ;;
esac
