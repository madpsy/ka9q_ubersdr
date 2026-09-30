#!/usr/bin/env bash
# wine_test.sh — omnirig-helper.exe end to end, under wine, with no OmniRig.
#
# Builds the helper and test/fake_omnirig.dll (../build.sh --test), registers the
# fake under OmniRig's ProgID in a throwaway wine prefix, and runs wine.test.js,
# which drives the real exe through OmniRigLink. The prefix is created and
# removed here; the one in ~/.wine is never touched.
#
# What it proves: the helper's COM and IDispatch calls, its stdin and stdout,
# and the link reading them. What it cannot: OmniRig itself, which runs out of
# process and has never been tried under wine. That needs Windows.
#
#   ./wine_test.sh             build, then test
#   ./wine_test.sh --no-build  test what is in ../dist
set -euo pipefail
cd "$(dirname "$0")"

command -v wine >/dev/null || { echo "wine not found" >&2; exit 1; }
command -v node >/dev/null || { echo "node not found" >&2; exit 1; }
if [ "${1:-}" != "--no-build" ]; then ../build.sh --test; fi
[ -f ../dist/test/fake_omnirig.dll ] || { echo "no fake_omnirig.dll — run without --no-build" >&2; exit 1; }

export WINEPREFIX; WINEPREFIX="$(mktemp -d "${TMPDIR:-/tmp}/omnirig-wine.XXXXXX")"
export WINEDEBUG=-all
cleanup() { wineserver -k >/dev/null 2>&1 || true; rm -rf "$WINEPREFIX"; }
trap cleanup EXIT

echo "creating a wine prefix …"
wineboot -i >/dev/null 2>&1

# The same CLSID fake_omnirig.cpp answers to.
CLS='{6A1C2E3D-8F0B-4C57-9E21-3B7D5A40F1C8}'
DLL="$(winepath -w "$(cd ../dist/test && pwd)/fake_omnirig.dll")"
wine reg add 'HKLM\Software\Classes\OmniRig.OmniRigX\CLSID' /ve /d "$CLS" /f >/dev/null
wine reg add "HKLM\\Software\\Classes\\CLSID\\$CLS\\InprocServer32" /ve /d "$DLL" /f >/dev/null
wine reg add "HKLM\\Software\\Classes\\CLSID\\$CLS\\InprocServer32" /v ThreadingModel /d Apartment /f >/dev/null

node wine.test.js
