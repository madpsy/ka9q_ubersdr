#!/usr/bin/env bash
# The helper's tests: whisper_core.cpp natively with the host's g++, then the
# real binary over its protocol (helper.test.js), which needs ../build.sh to
# have built it and fetched the models, and a speech sample — see the top of
# helper.test.js, and record.sh for making one off the air.
set -euo pipefail
cd "$(dirname "$0")"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
g++ -std=c++17 -Wall -Wextra -Werror -I.. core_test.cpp ../whisper_core.cpp -o "$out/core_test"
"$out/core_test"
# Bounded: a helper that hangs should fail the run, not stall it.
timeout 600 node helper.test.js
