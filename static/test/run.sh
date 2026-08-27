#!/usr/bin/env bash
# Tests for the standalone pages under static/ — the ones outside the v2 bundle.
#
# Plain node, no build step and no dependencies, because these pages have none either:
# they are loaded as-is by the browser, so the tests read the shipped files and run the
# functions out of them directly.
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "node not found" >&2; exit 1; }
node receiverspan.test.js
