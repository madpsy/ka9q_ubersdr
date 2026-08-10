#!/usr/bin/env bash
# The desktop client's own tests. Plain node, no dependencies — the modules
# under test are the ones that speak somebody else's protocol, which is where
# being wrong is silent.
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "node not found" >&2; exit 1; }
node tci.test.js
node tciserver.test.js
node wsserver.test.js
