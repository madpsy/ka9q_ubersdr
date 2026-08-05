#!/usr/bin/env bash
# Runs the Firefox extension's tests. Needs only esbuild and node — no npm
# install, matching static/v2/test/run.sh.
#
# The content script is tested against the *real* v2 page API rather than a
# mock of it, so the modules that implement that API are bundled here first.
# That is deliberate: the two sides ship separately and the whole risk is that
# they drift, so a test worth having has to run both.

set -euo pipefail
cd "$(dirname "$0")"

command -v esbuild >/dev/null || { echo "esbuild not found" >&2; exit 1; }
command -v node >/dev/null || { echo "node not found" >&2; exit 1; }

V2=../../../static/v2/src/bridge

mkdir -p .build
for m in protocol host commands snapshots; do
    esbuild "$V2/$m.js" --bundle --format=cjs --platform=node \
        --outfile=".build/bridge$m.cjs" --log-level=warning
done

node contract.test.js
node content_script.test.js
