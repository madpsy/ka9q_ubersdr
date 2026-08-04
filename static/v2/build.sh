#!/usr/bin/env bash
# build.sh — bundle the v2 frontend into static/v2/dist/
#
# Requires only esbuild, same as the repo's top-level build-js.sh. React comes
# from static/v2/vendor/ as UMD globals, so there is no npm install and no
# node_modules — `src/react.js` is the only file that touches those globals.
#
# Usage:
#   ./build.sh           production bundle (minified, no sourcemap)
#   ./build.sh --dev     unminified with an inline sourcemap
#   ./build.sh --watch   rebuild on change (implies --dev)

set -euo pipefail

cd "$(dirname "$0")"

ENTRY="src/main.jsx"
OUT="dist/v2.js"

MODE="prod"
for arg in "$@"; do
    case "$arg" in
        --dev) MODE="dev" ;;
        --watch) MODE="watch" ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

if ! command -v esbuild >/dev/null 2>&1; then
    echo "esbuild not found — apt-get install esbuild, or npm i -g esbuild" >&2
    exit 1
fi

for f in vendor/react.production.min.js vendor/react-dom.production.min.js; do
    [[ -f "$f" ]] || { echo "missing $f — see vendor/README.md" >&2; exit 1; }
done

mkdir -p dist

# JSX is compiled to React.createElement calls against the imported binding in
# src/react.js; nothing is resolved from node_modules.
COMMON=(
    "$ENTRY"
    --bundle
    --format=iife
    --target=es2020
    --jsx=transform
    --jsx-factory=React.createElement
    --jsx-fragment=React.Fragment
    --loader:.js=js
    # The @font-face src urls in styles.css are server paths, not files to
    # bundle: the woff2 sit in v2/fonts/ and are served from there. Without this
    # esbuild tries to resolve them against the filesystem and fails the build.
    --external:/v2/fonts/*
    # Same for the flag font, which lives with v1's under static/fonts/ rather
    # than being copied here — both frontends then share one cached file.
    --external:/fonts/*
    --log-level=warning
    --outfile="$OUT"
)

case "$MODE" in
    prod)
        esbuild "${COMMON[@]}" --minify
        echo "built $OUT ($(numfmt --to=iec < <(wc -c < "$OUT"))) and dist/v2.css"
        ;;
    dev)
        esbuild "${COMMON[@]}" --sourcemap=inline
        echo "built $OUT (dev)"
        ;;
    watch)
        esbuild "${COMMON[@]}" --sourcemap=inline --watch
        ;;
esac
