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

# The panel runtime is a bundle of its own: it runs inside each custom panel's
# sandboxed frame rather than in the app, and srcdoc.js inlines it there. Same
# esbuild, same settings, one entry point.
RUNTIME=(
    src/panels/custom/runtime.entry.js
    --bundle
    --format=iife
    --target=es2020
    --log-level=warning
    --outfile=dist/panel-runtime.js
)

# The names a manifest may use, for the admin editor to check one against.
#
# Generated from the source rather than written out again: the icon keys and the
# group ids are a published contract — a manifest out on the collector names one
# — and a hand-kept copy of them has already been wrong twice. test/custompanels
# pins this against the modules themselves, so a drift fails there rather than
# misleading an author.
panel_meta() {
    mkdir -p dist
    {
        printf '{\n  "icons": [\n'
        grep -oE '^    [A-Z][A-Za-z0-9]*: \(p\)' src/components/icons.jsx \
            | sed -E 's/^    ([A-Za-z0-9]+).*/    "\1",/' | sed '$ s/,$//'
        printf '  ],\n  "groups": [\n'
        grep -oE "^        id: '[a-z]+'," src/panels/groups.jsx \
            | sed -E "s/.*id: '([a-z]+)',/    \"\1\",/" | sed '$ s/,$//'
        printf '  ]\n}\n'
    } > dist/panel-meta.json
}

case "$MODE" in
    prod)
        esbuild "${COMMON[@]}" --minify
        esbuild "${RUNTIME[@]}" --minify
        panel_meta
        echo "built $OUT ($(numfmt --to=iec < <(wc -c < "$OUT"))), dist/panel-runtime.js and dist/v2.css"
        ;;
    dev)
        esbuild "${COMMON[@]}" --sourcemap=inline
        esbuild "${RUNTIME[@]}" --sourcemap=inline
        panel_meta
        echo "built $OUT and dist/panel-runtime.js (dev)"
        ;;
    watch)
        esbuild "${RUNTIME[@]}" --sourcemap=inline
        panel_meta
        esbuild "${COMMON[@]}" --sourcemap=inline --watch
        ;;
esac
