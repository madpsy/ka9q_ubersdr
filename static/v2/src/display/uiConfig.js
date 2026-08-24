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
//   v2 {…}                                   this interface's own defaults
//
// Most of that list is the classic interface's: the two disagree about what
// several of the shared-looking keys mean — `contrast` is a dB offset there and
// a gamma here, `smoothing` is spatial there and temporal here, and of its seven
// palettes this interface has two — so what applies to this one arrives in its
// own `v2` object rather than being read out of keys that mean something else.
// See ui_config_v2_defaults.go, which is where its shape is defined.
//
// What is read from the top level is what genuinely means the same thing in both
// interfaces: the backdrop, the station ID overlay, the auto-level minimum span
// and the default audio buffer. Values that drive rendering are parsed and
// validated onto the top level, so the draw path never re-parses a string, but
// nothing is dropped.

import { paletteMarks, PALETTE_NAMES } from '../lib/palettes.js';
import { UI_THEMES, uiColorsFrom } from '../lib/uiColors.js';

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
    // The operator's defaults for this interface, already translated into a
    // patch for the display settings — {} when they set none. Applied by
    // DisplayProvider to a browser that has never stored any of its own; see
    // the note on parseV2Defaults.
    v2Defaults: {},
    // The operator's page-load notices, in the order they are shown — empty
    // when there are none. Not defaults and not settings: they are shown to
    // everybody on every load, which is why they arrive beside `v2` rather than
    // in it. See parseNotices.
    notices: [],
};

// ── The operator's v2 defaults ───────────────────────────────────────────────
//
// Three tables rather than one switch, because each kind needs a different
// check, and because being tables is what lets the Go side test itself against
// them: ui_config_v2_defaults_test.go reads this file and the two colour modules
// and fails if the admin UI would offer a value this interface cannot act on, or
// miss one it can. The lists are therefore written as plain literals — keep them
// that way.
//
// The key on the left is what the server sends; `key` is the display setting it
// sets. They differ in case only by convention (snake_case on the wire,
// camelCase in the settings), which is deliberate: the wire names are an
// operator-facing contract in ui.yaml and should not follow a rename in here.

/** Numeric settings, with the bounds of the Display panel's own slider. */
export const V2_RANGES = {
    ui_scale: { key: 'uiScale', min: 0.75, max: 1.6 },
    contrast: { key: 'contrast', min: 0.4, max: 2.5 },
    dss_seconds: { key: 'dssSeconds', min: 1, max: 30 },
    waterfall_rate: { key: 'waterfallRate', min: 2, max: 40 },
    row_height: { key: 'rowHeight', min: 1, max: 4 },
    smoothing: { key: 'smoothing', min: 0, max: 0.92 },
};

/** Settings that are one of a fixed set of words. */
export const V2_ENUMS = {
    view_mode: { key: 'viewMode', values: ['split', 'spectrum', 'waterfall'] },
    waterfall_mode: { key: 'waterfallMode', values: ['2d', '3d', 'both'] },
    waterfall_pan: { key: 'waterfallPan', values: ['follow', 'hold'] },
};

/** Plain switches. */
export const V2_BOOLS = {
    smooth_scroll: 'smoothScroll',
    peak_hold: 'peakHold',
    fill: 'fill',
    grid: 'grid',
};

const clamp01 = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * The operator's `ui.v2` block as a patch for the display settings.
 *
 * Absent is the whole point: every key is optional, and one that is not there
 * means the operator did not choose — not that they chose what this interface
 * already does. So an untouched receiver produces {} and nothing is applied,
 * which is what keeps a default changed here reaching everybody rather than
 * being frozen at whatever the server last serialised.
 *
 * This interface is the authority on what it can act on, not the server: a key
 * it does not know, a palette it does not have, a word that is not one of the
 * choices — all ignored rather than written into the settings, because a
 * receiver may be running a server newer than its client (or the reverse), and
 * an unusable value stored is one the listener then has to find and undo.
 *
 * Numbers are clamped rather than dropped. The admin UI cannot produce one out
 * of range and the server rejects it on save, so the only way here is a
 * hand-edited ui.yaml — where the nearest legal value is much likelier to be
 * what was meant than nothing at all.
 */
export function parseV2Defaults(v2) {
    if (!v2 || typeof v2 !== 'object' || Array.isArray(v2)) return {};
    const out = {};

    // A colour scheme is the accent, the text colours and the dark/light base
    // together — the same one choice the Colours menu makes, applied the same
    // way, so an operator default and a listener picking it by hand land on
    // identical settings.
    if (typeof v2.color_scheme === 'string') {
        const preset = UI_THEMES.find((p) => p.id === v2.color_scheme);
        if (preset) {
            out.uiColors = uiColorsFrom(preset);
            if (preset.theme) out.theme = preset.theme;
        }
    }

    if (typeof v2.palette === 'string' && PALETTE_NAMES.includes(v2.palette)) {
        out.palette = v2.palette;
    }

    for (const [wire, spec] of Object.entries(V2_ENUMS)) {
        if (spec.values.includes(v2[wire])) out[spec.key] = v2[wire];
    }

    for (const [wire, key] of Object.entries(V2_BOOLS)) {
        if (typeof v2[wire] === 'boolean') out[key] = v2[wire];
    }

    for (const [wire, spec] of Object.entries(V2_RANGES)) {
        const n = parseFloat(v2[wire]);
        if (Number.isFinite(n)) out[spec.key] = clamp01(n, spec.min, spec.max);
    }

    return out;
}

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

// ── The operator's page-load notice ──────────────────────────────────────────

/** Severities the interface can draw, and nothing else. */
const NOTICE_SEVERITIES = ['info', 'warning', 'good'];

/**
 * Is this a link worth offering? The server checks the same thing on the way
 * out (see noticeLinkOK in ui_config_notice.go), and it is checked again here
 * because a scheme test is cheap and this value ends up in an href — the one
 * field of the notice a listener can be sent somewhere by.
 */
export function noticeLinkOk(href) {
    if (typeof href !== 'string' || !href || href.length > 500) return false;
    // Protocol-relative: no scheme to test, and a browser would follow it.
    if (href.startsWith('//')) return false;
    try {
        // A base is supplied so a relative path parses rather than throwing;
        // one that resolves against the page is then rejected by the scheme
        // test below, which is what should happen to it.
        const u = new URL(href, 'https://invalid.example/');
        if (u.protocol === 'mailto:') return true;
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        // Rejects a relative path, which resolved against the fake base above.
        return u.hostname !== 'invalid.example' || /^https?:/i.test(href);
    } catch (e) {
        return false;
    }
}

/**
 * The `v2_notices` list, in the order the operator wrote it.
 *
 * Anything that would draw an empty card is dropped rather than kept as a hole:
 * the component then has a list it can map over with no further tests, and one
 * malformed entry does not take the notices after it with it.
 */
export function parseNotices(list) {
    if (!Array.isArray(list)) return [];
    return list.map(parseNotice).filter(Boolean).slice(0, 3);
}

/**
 * One `v2_notices` entry, checked into something the component can render
 * without asking any further questions of it.
 *
 * Everything is re-checked rather than trusted, on the same principle the rest
 * of this file follows: the interface is the authority on what it can draw, and
 * a receiver may be running a server newer or older than its client. It also
 * costs nothing — this runs once per page load.
 *
 * Null for anything that would draw an empty box, so the component has one test
 * to make and no partial state to reason about.
 */
export function parseNotice(n) {
    if (!n || typeof n !== 'object' || Array.isArray(n)) return null;

    const title = typeof n.title === 'string' ? n.title.trim().slice(0, 200) : '';
    const text = typeof n.text === 'string' ? n.text.trim().slice(0, 700) : '';
    if (!title && !text) return null;

    const secs = Number(n.timeout_seconds);
    const seconds = Number.isFinite(secs) ? Math.max(0, Math.min(60, secs)) : 3;

    const href = typeof n.link_url === 'string' ? n.link_url.trim() : '';
    const link = noticeLinkOk(href)
        ? {
            href,
            label: (typeof n.link_label === 'string' && n.link_label.trim().slice(0, 60)) || 'Open',
        }
        : null;

    return {
        // Which notice this is, by its wording — so "seen once" survives a
        // reload and stops applying the moment the operator edits it.
        id: typeof n.id === 'string' && n.id ? n.id : `${title}|${text}`,
        severity: NOTICE_SEVERITIES.includes(n.severity) ? n.severity : 'info',
        title,
        text,
        link,
        seconds,
        // A notice that neither times out nor closes is a permanent obstruction
        // over somebody's spectrum, whatever the config says. The two answers
        // are combined here rather than left to the component, so there is one
        // place this cannot be got wrong.
        dismissible: n.dismissible !== false || seconds === 0,
        once: n.repeat === 'once',
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
        v2Defaults: parseV2Defaults(cfg.v2),
        notices: parseNotices(cfg.v2_notices),
    };
}
