// Operator display settings from /api/ui-config.
//
// The reply is kept verbatim under `config` so every key stays reachable
// without editing this file again. As of writing the server sends:
//
//   spectrum_bg_image, spectrum_bg_opacity   backdrop behind the spectrum
//   palette, contrast, smoothing, peak_hold  waterfall / trace appearance
//   line_graph, gpu_scroll, min_span         spectrum behaviour
//   band_color_intensity, bandwidth_indicator_color   (the latter is v1's, and
//                                            not read here — see markColors)
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
    // null when the operator has not chosen one, which is not the same as white:
    // an unset colour follows the interface's own ink over the canvas (see
    // --spec-ink), and a set one is the operator's decision and is obeyed. Keeping
    // the two apart is what lets a receiver's own branding survive a listener's
    // colour scheme while an untouched default follows it.
    stationIdColor: null,
    autoMinSpan: 30,            // operator's default minimum dynamic range, dB
    // The operator's default audio buffer ceiling, seconds. Sent as a string of
    // milliseconds ("200"). null when the server did not say, which is not the
    // same as 0 — see the AudioDefaults bridge in App.jsx.
    bufferSec: null,
};

/**
 * What colour the dial line and the passband edges are drawn in.
 *
 * Two sources, most specific first:
 *
 *   this browser   `markOverrides[palette]` from the Display panel. Absent
 *                  unless somebody picked one.
 *   the palette    paletteMarks(), the default: hues the chosen colour map does
 *                  not itself contain.
 *
 * `bandwidth_indicator_color` from /api/ui-config is deliberately *not* a third
 * source, though it looks like one. Two things about it:
 *
 *   The server substitutes "green" when the operator has set nothing
 *   (ui_config_api.go), so "not chosen" and "chose green" arrive identically —
 *   there is no reading of that field under which a palette's own colour could
 *   ever win, and every palette came out green, radar included.
 *
 *   And it is not a mandate anyway. v1 uses it once, to seed localStorage on
 *   first run (ui-config.js), after which its own colour menu writes over it. It
 *   is the first-run default for a per-user setting, and v2's equivalent of that
 *   setting is the picker under the palette grid — which is per palette, because
 *   what contrasts with the colour map is the actual question.
 *
 * Takes the whole display state so both callers pass the same thing: the
 * spectrum draws from it, and the Display panel's pickers have to *open* on it —
 * a picker that opened on black when nothing had been chosen would start every
 * first drag from the wrong end of the colour space.
 */
export function markColors(d) {
    const marks = paletteMarks(d.palette);
    const mine = (d.markOverrides && d.markOverrides[d.palette]) || {};
    return {
        dial: mine.dial || marks.vfo,
        edge: mine.edge || marks.edge,
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
        // White is read as "the operator did not choose", not as a choice.
        //
        // The config has no way to say unset — the receiver sends
        // station_id_color: "#ffffff" whether or not anybody picked it, which is
        // its own default written out — and taking that literally would mean the
        // overlay stayed white on every receiver in existence, whatever the
        // listener's colour scheme said. An operator who genuinely wants white
        // still very nearly gets it: the fallback is the interface's ink over the
        // canvas, which is near-white unless a scheme has been chosen.
        //
        // Temporary. When the server can distinguish an unset key from a chosen
        // colour, this becomes the plain format test again.
        stationIdColor: /^#[0-9a-fA-F]{6}$/.test(col) && col.toLowerCase() !== '#ffffff'
            ? col
            : null,
        autoMinSpan: Number.isFinite(minSpan)
            ? Math.max(0, Math.min(60, minSpan))
            : UI_CONFIG_DEFAULTS.autoMinSpan,
        bufferSec: Number.isFinite(bufferMs) && bufferMs > 0
            ? Math.max(0.05, Math.min(2, bufferMs / 1000))
            : UI_CONFIG_DEFAULTS.bufferSec,
    };
}
