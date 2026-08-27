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
for m in protocol host; do
    esbuild "$V2/$m.js" --bundle --format=cjs --platform=node \
        --outfile=".build/bridge$m.cjs" --log-level=warning
done

# The snapshots, and the constants they read the receiver's tuning range out of, as
# one bundle. constants.js holds MIN_FREQ/MAX_FREQ as *live* bindings that
# applyTuningRange rewrites when /api/description lands, so bundling it separately would
# hand the tests a second copy — one the snapshots never read, making a test that adopts
# a 60 MHz range pass while proving nothing.
cat > .build/snapshots-entry.js <<'ENTRY'
export * from '../../../../static/v2/src/bridge/snapshots.js';
export * from '../../../../static/v2/src/radio/constants.js';
ENTRY
esbuild .build/snapshots-entry.js --bundle --format=cjs --platform=node \
    --outfile=".build/bridgesnapshots.cjs" --log-level=warning

# The commands, and the registry of radio-control transports they write to, as
# one bundle. Separately bundled they would be two copies of a module that is a
# singleton, so a test would be reading a registry nothing had written to.
cat > .build/commands-entry.js <<'ENTRY'
export * from '../../../../static/v2/src/bridge/commands.js';
export * from '../../../../static/v2/src/controls/radioProviders.js';
ENTRY
esbuild .build/commands-entry.js --bundle --format=cjs --platform=node \
    --outfile=".build/bridgecommands.cjs" --log-level=warning


node popup_range.test.js
node contract.test.js
node content_script.test.js
node background.test.js
