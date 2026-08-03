#!/usr/bin/env bash
# Runs the v2 protocol tests. Needs only esbuild and node — no npm install.
#
# These cover the two binary wire formats (spectrum SPEC frames and the v2 Opus
# audio header), which are the parts of the client where a silent off-by-one
# produces plausible-looking garbage rather than an error.

set -euo pipefail
cd "$(dirname "$0")"

command -v esbuild >/dev/null || { echo "esbuild not found" >&2; exit 1; }
command -v node >/dev/null || { echo "node not found" >&2; exit 1; }

mkdir -p .build
esbuild ../src/radio/spectrum-connection.js --bundle --format=cjs --platform=node \
    --outfile=.build/spectrum.cjs --log-level=warning
esbuild ../src/radio/audio-connection.js --bundle --format=cjs --platform=node \
    --outfile=.build/audio.cjs --log-level=warning
esbuild ../src/radio/constants.js --bundle --format=cjs --platform=node \
    --outfile=.build/constants.cjs --log-level=warning
esbuild ../src/lib/dsp.js --bundle --format=cjs --platform=node \
    --outfile=.build/dsp.cjs --log-level=warning
esbuild ../src/display/uiConfig.js --bundle --format=cjs --platform=node \
    --outfile=.build/uiconfig.cjs --log-level=warning
esbuild ../src/lib/format.js --bundle --format=cjs --platform=node \
    --outfile=.build/format.cjs --log-level=warning
esbuild ../src/lib/markers.js --bundle --format=cjs --platform=node \
    --outfile=.build/markers.cjs --log-level=warning
esbuild ../src/lib/audioBand.js --bundle --format=cjs --platform=node \
    --outfile=.build/audioband.cjs --log-level=warning
esbuild ../src/radio/audio-filters.js --bundle --format=cjs --platform=node \
    --outfile=.build/audiofilters.cjs --log-level=warning
esbuild ../src/lib/mentions.js --bundle --format=cjs --platform=node \
    --outfile=.build/mentions.cjs --log-level=warning

node unresolved.js
node protocol.test.js
