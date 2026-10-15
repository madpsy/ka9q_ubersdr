#!/usr/bin/env bash
# The mobile client's own tests. Plain node and esbuild, no npm install — the
# same arrangement as static/v2/test/run.sh, because the code under test is ES
# modules written for a WebView and has to be bundled before node can load it.
#
# What is tested is the shared JavaScript both apps inject into a receiver page
# (src/), against the stubs of a host; the native halves are compiled by
# build.sh and build-mac.sh and are not exercised here.
set -euo pipefail
cd "$(dirname "$0")"

command -v esbuild >/dev/null || { echo "esbuild not found" >&2; exit 1; }
command -v node >/dev/null || { echo "node not found" >&2; exit 1; }

mkdir -p .build
esbuild ../src/hostspeech.js --bundle --format=cjs --platform=node \
    --outfile=.build/hostspeech.cjs --log-level=warning
# v2's own engine, so the shim is tested against the page that will drive it
# rather than against this file's reading of the contract.
esbuild ../../../static/v2/test/whisperengines.entry.js --bundle --format=cjs --platform=node \
    --outfile=.build/whisperengines.cjs --log-level=warning

node hostspeech.test.js
