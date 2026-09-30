#!/usr/bin/env bash
# The helper's native tests: omnirig_core.cpp against a fake rig, built with the
# host's g++. No Windows, wine or Docker needed — see wine_test.sh for the half
# that does.
set -euo pipefail
cd "$(dirname "$0")"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
g++ -std=c++17 -Wall -Wextra -Werror -I.. core_test.cpp ../omnirig_core.cpp -o "$out/core_test"
"$out/core_test"
