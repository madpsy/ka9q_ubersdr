#!/usr/bin/env bash
# record.sh — a speech sample off the air, for helper.test.js.
#
#   ./record.sh [seconds] [out.wav]      (default 10 s into fixtures/speech.wav)
#
# Records a live receiver through clients/python/radio_client.py and resamples
# it to 16 kHz mono with sox, the format the helper takes. Pick a moment with
# somebody talking: the test asserts there are words in it.
#
# Environment (defaults are a medium-wave broadcast that talks most of the day):
#   UBERSDR_URL     ws://44.31.241.7:8080/ws
#   UBERSDR_FREQ    909000
#   UBERSDR_MODE    am
#   UBERSDR_RATE    24000, what radio_client.py writes for AM. Its stderr says
#                   12000; that label is stale, and at the wrong rate Whisper
#                   hallucinates fluently, so check this before trusting a
#                   recording in another mode.
#   PYTHON          python3 (needs radio_client.py's requirements)
set -euo pipefail
cd "$(dirname "$0")"
SECONDS_WANTED="${1:-10}"
OUT="${2:-fixtures/speech.wav}"
URL="${UBERSDR_URL:-ws://44.31.241.7:8080/ws}"
FREQ="${UBERSDR_FREQ:-909000}"
MODE="${UBERSDR_MODE:-am}"
RATE="${UBERSDR_RATE:-24000}"
PY="${PYTHON:-python3}"
CLIENT="$(cd ../../../python && pwd)/radio_client.py"
command -v sox >/dev/null || { echo "sox is required" >&2; exit 1; }
mkdir -p "$(dirname "$OUT")"
# head -c ends the pipe after exactly the seconds asked for; the client then
# dies of SIGPIPE, which is its normal way out here.
"$PY" "$CLIENT" --no-gui -u "$URL" -f "$FREQ" -m "$MODE" -o stdout 2>/dev/null \
  | head -c $((RATE * 2 * SECONDS_WANTED)) \
  | sox -t raw -r "$RATE" -e signed -b 16 -c 1 - -r 16000 -c 1 "$OUT" || true
[ -s "$OUT" ] || { echo "nothing recorded" >&2; exit 1; }
echo "$OUT: $(soxi -D "$OUT") s"
