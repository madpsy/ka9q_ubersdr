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

node protocol.test.js
