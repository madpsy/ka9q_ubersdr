// Operator display settings from /api/ui-config.
//
// The reply is kept verbatim under `config` so every key stays reachable
// without editing this file again. As of writing the server sends:
//
//   spectrum_bg_image, spectrum_bg_opacity   backdrop behind the spectrum
//   palette, contrast, smoothing, peak_hold  waterfall / trace appearance
//   line_graph, gpu_scroll, min_span         spectrum behaviour
//   band_color_intensity, bandwidth_indicator_color
//   theme {accent, accent_end, page_bg, panel_dark, panel_mid, text_light,
//          control_text}                     operator colour overrides
//   station_id_overlay, station_id_color     callsign watermark
//   controls_opacity                         v1 control-bar transparency
//   signal_meter_mode, smeter_mode, smeter_charts_visible, vu_meter_style
//   mobile_tuning_mode, default_buffer, allowed_postmessage_origins
//
// Only the backdrop and the station ID overlay are consumed so far. Values
// that drive rendering are also
// parsed and validated onto the top level, so the draw path never re-parses a
// string, but nothing is dropped.

import { paletteMarks } from '../lib/palettes.js';

export const UI_CONFIG_DEFAULTS = {
    loaded: false,
    config: {},
    bgImage: '',
    bgOpacity: 0.3,
    stationIdOverlay: true,     // absent key means show, as in v1
    stationIdColor: '#ffffff',
    autoMinSpan: 30,            // operator's default minimum dynamic range, dB
    // The operator's passband-edge colour name, empty when they have not set
    // one. Named to match what parseUiConfig produces — a `bandwidthColor` key
    // here was never populated by the parser, so the defaults and a parsed
    // config disagreed about what the field was even called.
    bandwidthColorName: '',
    // The operator's default audio buffer ceiling, seconds. Sent as a string of
    // milliseconds ("200"). null when the server did not say, which is not the
    // same as 0 — see the AudioDefaults bridge in App.jsx.
    bufferSec: null,
};

// v1's palette for the bandwidth indicator (spectrum-display.js
// getBandwidthIndicatorColor), so the passband markers match between frontends.
const BANDWIDTH_COLORS = {
    green: '0, 255, 0',
    red: '255, 0, 0',
    cyan: '0, 255, 255',
    white: '255, 255, 255',
    yellow: '255, 255, 0',
    orange: '255, 165, 0',
    magenta: '255, 0, 255',
};

export function bandwidthColor(name, alpha) {
    const rgb = BANDWIDTH_COLORS[String(name || '').toLowerCase()] || BANDWIDTH_COLORS.green;
    return `rgba(${rgb}, ${alpha})`;
}

/**
 * What colour the dial line and the passband edges are drawn in.
 *
 * Three sources, most specific first:
 *
 *   this browser   `markOverrides[palette]` from the Display panel. Absent
 *                  unless somebody picked one, and the only way to override the
 *                  two below.
 *   the operator   `bandwidth_indicator_color` from /api/ui-config, which v1
 *                  also honours — so a receiver that has chosen a house colour
 *                  for the passband keeps it, and the two frontends agree. It
 *                  applies to the passband only; there is no dial equivalent.
 *   the palette    paletteMarks(), the default: hues the chosen colour map does
 *                  not itself contain.
 *
 * Takes the whole display state so both callers pass the same thing: the
 * spectrum draws from it, and the Display panel's pickers have to *open* on it —
 * a picker that opened on black when nothing had been chosen would start every
 * first drag from the wrong end of the colour space.
 */
export function markColors(d) {
    const marks = paletteMarks(d.palette);
    const mine = (d.markOverrides && d.markOverrides[d.palette]) || {};
    const operatorEdge = d.server && d.server.bandwidthColorName
        ? bandwidthColor(d.server.bandwidthColorName, 1)
        : '';
    return {
        dial: mine.dial || marks.vfo,
        edge: mine.edge || operatorEdge || marks.edge,
    };
}

export function parseUiConfig(cfg) {
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { ...UI_CONFIG_DEFAULTS };
    const o = parseFloat(cfg.spectrum_bg_opacity);
    const col = typeof cfg.station_id_color === 'string' ? cfg.station_id_color.trim() : '';
    // `min_span` is the operator's default for the auto-level minimum dynamic
    // range, in dB (0 = no minimum). Sent as a plain number, but the config
    // type carries min/max too, so an object with a `default` is accepted.
    const minSpan = parseFloat(
        cfg.min_span && typeof cfg.min_span === 'object' ? cfg.min_span.default : cfg.min_span,
    );
    // v1's presets run 50–500 ms; the range is widened a little rather than
    // enumerated, so an operator who sets something in between is honoured
    // instead of silently ignored.
    const bufferMs = parseFloat(cfg.default_buffer);
    return {
        loaded: true,
        config: cfg,
        bgImage: typeof cfg.spectrum_bg_image === 'string' ? cfg.spectrum_bg_image : '',
        bgOpacity: Number.isFinite(o)
            ? Math.max(0, Math.min(1, o))
            : UI_CONFIG_DEFAULTS.bgOpacity,
        stationIdOverlay: cfg.station_id_overlay !== false,
        stationIdColor: /^#[0-9a-fA-F]{6}$/.test(col) ? col : UI_CONFIG_DEFAULTS.stationIdColor,
        // Empty when the operator did not set one, which is not the same as
        // their having chosen v1's default: absent has to fall through to the
        // palette's own colour (see markColors), and 'green' would pin every
        // palette to green whether it suits the colour map or not.
        bandwidthColorName: typeof cfg.bandwidth_indicator_color === 'string'
            ? cfg.bandwidth_indicator_color.trim() : '',
        autoMinSpan: Number.isFinite(minSpan)
            ? Math.max(0, Math.min(60, minSpan))
            : UI_CONFIG_DEFAULTS.autoMinSpan,
        bufferSec: Number.isFinite(bufferMs) && bufferMs > 0
            ? Math.max(0.05, Math.min(2, bufferMs / 1000))
            : UI_CONFIG_DEFAULTS.bufferSec,
    };
}
