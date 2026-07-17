#!/usr/bin/env bash
# build-js.sh — Bundle and minify static JS files for index.html
# Reduces ~78 JS GETs on page load to ~8
#
# Requires: esbuild (https://esbuild.github.io/)
#   apt-get install esbuild   OR   npm install -g esbuild
#
# Usage:
#   ./build-js.sh          — minified production bundles → static/dist/
#   ./build-js.sh --dev    — concatenated only, no minify (for debugging)
#
# ── What gets bundled ──────────────────────────────────────────────────────────
#
#  head-bundle.min.js   (8 plain globals scripts loaded in <head>)
#  body-bundle.min.js   (22 plain globals scripts loaded in <body>)
#  app.bundle.min.js    (app.js + its 4 ES module imports, via esbuild --bundle)
#  local-bookmarks.bundle.min.js  (local-bookmarks-ui.js + local-bookmarks.js)
#
# ── What stays separate (NOT bundled) ─────────────────────────────────────────
#
#  browser-extension-detector.js  — must be first script in <head>
#  opus-decoder.min.js            — vendor, already minified
#  jszip.min.js                   — vendor, already minified
#  qrcode.min.js                  — vendor, already minified
#  chat.js / chat-ui.js           — conditional: loaded only if chat_enabled
#  rotator-ui.js                  — conditional: loaded only if rotator/ant_switch enabled
#  rotator-display.js             — conditional: loaded only if rotator enabled
#  d3.v7.min.js                   — conditional: loaded only if rotator enabled
#  d3-geo.v3.min.js               — conditional: loaded only if rotator enabled
#  topojson.v3.min.js             — conditional: loaded only if rotator enabled
#  sw.js                          — service worker (registered via JS, not a <script> tag)
#  pcm-recorder-worklet.js        — AudioWorklet (loaded via audioContext.audioWorklet.addModule)
#  static/extensions/*/           — lazy-loaded per server config, already optimal
#
# ── Other pages (NOT index.html) — not touched ────────────────────────────────
#  admin-logs.js, bandconditions.js, noisefloor.js, session_stats.js,
#  cwskimmer_map.js, digitalspots_map.js, decoder_spots_history*.js,
#  cw_spots_*.js, notifications-*.js, stats_history.js, spaceweather_history.js,
#  setup-wizard.js, config-help.js, create_public.js, radiod_config_analyzer.js,
#  timetravel.js, minimal-radio.js, server-nr.js, noise-analysis-overlay.js,
#  maidenhead-grid.js, psk_rank.js, wspr_rank.js, wspr_phone_prediction.js,
#  pskreporter_analytics.js, decode_metrics.js, decode_rates.js, date-picker.js,
#  cw_metrics.js, languages.js, noisefloor_aggregate.js,
#  chart.umd.min.js, chartjs-*.min.js, leaflet*.js, L.Terminator.js,
#  codemirror-bundle.min.js, d3*.min.js (other pages)

set -euo pipefail

STATIC="static"
DIST="static/dist"
DEV=false

if [[ "${1:-}" == "--dev" ]]; then
    DEV=true
fi

mkdir -p "$DIST"

echo "==> Building JS bundles (dev=$DEV)..."

# ── Head bundle ────────────────────────────────────────────────────────────────
# Loaded in <head>, blocking. Order matches index.html lines 69-78.
HEAD_SRCS=(
    "$STATIC/suncalc.js"
    "$STATIC/maidenhead.js"
    "$STATIC/fft.js"
    "$STATIC/nr2.js"
    "$STATIC/websdr-nr.js"
    "$STATIC/noise-blanker.js"
    "$STATIC/filters.js"
    "$STATIC/rmnoise.js"
)

# ── Body bundle ────────────────────────────────────────────────────────────────
# Plain globals scripts loaded sequentially in <body>.
# Order matches index.html lines 1610-1742 (excluding conditional loaders,
# qrcode.min.js vendor, and the two ES module scripts).
BODY_SRCS=(
    "$STATIC/bands_state.js"
    "$STATIC/band-freq-toggle.js"
    "$STATIC/extensions.js"
    "$STATIC/extension-loader.js"
    "$STATIC/extension-resize.js"
    "$STATIC/carrier-detector.js"
    "$STATIC/signal-meter.js"
    "$STATIC/s-meter-needle.js"
    "$STATIC/ui-config.js"
    "$STATIC/spectrum-display.js"
    "$STATIC/spectrum-webgl.js"
    "$STATIC/oscilloscope.js"
    "$STATIC/recorder.js"
    "$STATIC/idle-detector.js"
    "$STATIC/dxcluster-client.js"
    "$STATIC/time-display.js"
    "$STATIC/space-weather-display.js"
    "$STATIC/voice-activity-service.js"
    "$STATIC/voice-activity-markers.js"
    "$STATIC/tts-announcements.js"
    "$STATIC/welcome-tour.js"
    "$STATIC/pages-menu.js"
)

# ── Helper: bundle plain globals scripts ───────────────────────────────────────
bundle_globals() {
    local outfile="$1"
    shift
    local srcs=("$@")

    for f in "${srcs[@]}"; do
        if [[ ! -f "$f" ]]; then
            echo "  ERROR: missing source file: $f" >&2
            exit 1
        fi
    done

    if $DEV; then
        cat "${srcs[@]}" > "$outfile"
        echo "  [dev] concatenated ${#srcs[@]} files → $outfile"
    else
        # cat preserves load order, pipe through esbuild transform mode
        # (stdin = no entry point = transform mode, not bundle mode).
        # --minify compresses without rewriting module references — safe for globals.
        cat "${srcs[@]}" | esbuild \
            --minify \
            --log-level=warning \
            > "$outfile"
        local size
        size=$(wc -c < "$outfile")
        echo "  bundled ${#srcs[@]} files → $outfile ($(numfmt --to=iec $size))"
    fi
}

# ── Helper: bundle an ES module entry point ────────────────────────────────────
# esbuild follows all import statements and produces a single IIFE.
# IIFE format means no type="module" needed in the HTML — works as a plain script.
# app.js imports: websocket-manager.js, bookmark-manager.js,
#                 bandwidth-control.js, wake-lock.js
# local-bookmarks-ui.js imports: local-bookmarks.js
bundle_esm() {
    local entry="$1"
    local outfile="$2"

    if [[ ! -f "$entry" ]]; then
        echo "  ERROR: missing entry point: $entry" >&2
        exit 1
    fi

    if $DEV; then
        esbuild "$entry" \
            --bundle \
            --format=iife \
            --log-level=warning \
            --outfile="$outfile"
        echo "  [dev] bundled ESM $entry → $outfile"
    else
        esbuild "$entry" \
            --bundle \
            --format=iife \
            --minify \
            --log-level=warning \
            --outfile="$outfile"
        local size
        size=$(wc -c < "$outfile")
        echo "  bundled ESM $entry → $outfile ($(numfmt --to=iec $size))"
    fi
}

# ── Build all four bundles ─────────────────────────────────────────────────────

echo ""
echo "1/4  head-bundle  (${#HEAD_SRCS[@]} files → dist/head-bundle.min.js)"
bundle_globals "$DIST/head-bundle.min.js" "${HEAD_SRCS[@]}"

echo ""
echo "2/4  body-bundle  (${#BODY_SRCS[@]} files → dist/body-bundle.min.js)"
bundle_globals "$DIST/body-bundle.min.js" "${BODY_SRCS[@]}"

echo ""
echo "3/4  app.bundle  (app.js + websocket-manager.js + bookmark-manager.js + bandwidth-control.js + wake-lock.js)"
bundle_esm "$STATIC/app.js" "$DIST/app.bundle.min.js"

echo ""
echo "4/4  local-bookmarks.bundle  (local-bookmarks-ui.js + local-bookmarks.js)"
bundle_esm "$STATIC/local-bookmarks-ui.js" "$DIST/local-bookmarks.bundle.min.js"

echo ""
echo "==> Done. Output:"
ls -lh "$DIST/"*.js 2>/dev/null
