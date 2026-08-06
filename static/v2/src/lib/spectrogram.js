// The rolling 24-hour spectrogram, as the panel needs it.
//
// The server holds the rolling window in memory and re-renders it once a
// minute, so both the thumbnail and the full-size image are memory reads —
// which is what makes a panel that shows one affordable at all. Two sizes, one
// endpoint each:
//
//   /api/spectrogram/thumb?rolling=1&band=…   300×168, tens of kB
//   /api/spectrogram?rolling=1&band=…         full resolution, megabytes
//
// The full-size image is only ever fetched when someone opens the modal.

export const POLL_MS = 60000;          // the window advances one row a minute

// The band shown when the dial is not inside an amateur band. wideband-hf is
// the 0–30 MHz recorder cropped to 1.8–30 MHz: the same picture as `wideband`
// with AM broadcast left out, which is what makes the rest of it readable.
export const DEFAULT_BAND = 'wideband-hf';

export function spectrogramEnabled(serverInfo) {
    return !!(serverInfo && serverInfo.spectrogram);
}

export function listUrl() {
    return '/api/spectrogram/list';
}

function bandParam(band) {
    return band && band !== 'wideband' ? `&band=${encodeURIComponent(band)}` : '';
}

// `at` busts the browser cache on the minute rather than on every render: the
// image genuinely changes once a minute and the response carries max-age=60.
export function thumbUrl(band, at) {
    return `/api/spectrogram/thumb?rolling=1${bandParam(band)}${at ? `&t=${at}` : ''}`;
}

export function fullUrl(band, at) {
    return `/api/spectrogram?rolling=1${bandParam(band)}${at ? `&t=${at}` : ''}`;
}

export function metaUrl(band) {
    return `/api/spectrogram/meta?rolling=1${bandParam(band)}`;
}

// Which recorder to show: the band the dial is in if the server records it,
// otherwise the wideband HF view. `available` is the list from /api/spectrogram/list.
export function bandForView(available, dialBand) {
    if (dialBand && available && available.includes(dialBand)) return dialBand;
    return DEFAULT_BAND;
}

// What a band's picture covers, for the line under it: "7.000–7.200 MHz".
//
// `ranges` is band_ranges from /api/spectrogram/list — the recorder's own span,
// which is not the band plan's: a 40m recorder configured for 7.0–7.2 MHz does
// not cover the top 100 kHz of the band, and saying it does would be a caption
// that disagrees with the picture under it.
//
// Empty string when the range is not known, never the band's own name. Printing
// the name here put "40m 40m" under every band's thumbnail — the caller is
// already showing the name beside this.
export function bandLabel(band, ranges) {
    const r = ranges && ranges[band];
    if (r && r.end_freq_hz > r.start_freq_hz) return formatRange(r.start_freq_hz, r.end_freq_hz);
    // Fallbacks for a server that predates band_ranges. The two wideband views
    // are fixed by what the recorder is.
    if (band === 'wideband') return '0–30 MHz';
    if (band === DEFAULT_BAND) return '1.8–30 MHz';
    return '';
}

// A span as two numbers and one unit. Both ends at the same precision, so they
// read as a pair rather than as two unrelated figures — and at whatever
// precision the ends themselves need, not one chosen from how wide the span is.
// wideband-hf starts at 1.8 MHz across a 28 MHz span: picking the precision
// from the span printed it as "2–30 MHz", which is not where it starts.
export function formatRange(startHz, endHz) {
    const needs = (hz) => (hz % 1e6 === 0 ? 0 : hz % 100e3 === 0 ? 1 : 3);
    const dp = Math.max(needs(startHz), needs(endHz));
    return `${(startHz / 1e6).toFixed(dp)}–${(endHz / 1e6).toFixed(dp)} MHz`;
}

// ── Axes ─────────────────────────────────────────────────────────────────────
//
// Both are the same shape as spectrogram.html's, minus the zoom: this image is
// drawn at one scale, so a tick is a percentage across (frequency) or down
// (time) and nothing has to be recomputed as anything moves.

// Major/minor tick spacing by span, from spectrogram.html's buildFreqAxis().
const FREQ_INTERVALS = [
    [25e6, 5e6], [12e6, 2e6], [6e6, 1e6], [3e6, 500e3], [1.5e6, 200e3],
    [600e3, 100e3], [300e3, 50e3], [150e3, 25e3], [60e3, 10e3], [25e3, 5e3],
    [10e3, 2e3], [5e3, 1e3], [2e3, 500], [1e3, 200], [500, 100], [0, 50],
];

export function freqTickStep(spanHz) {
    for (const [min, step] of FREQ_INTERVALS) {
        if (spanHz >= min) return step;
    }
    return 50;
}

// Decimals from the value, not from its magnitude: a 20m recorder ticks every
// 25 kHz, and rounding 14.025 MHz to one decimal prints three ticks all reading
// "14.0". This is spectrogram.html's fmtHz.
export function formatTickHz(hz) {
    if (hz >= 1e6) {
        const dp = hz % 1e6 === 0 ? 0 : hz % 100e3 === 0 ? 1 : 3;
        return `${(hz / 1e6).toFixed(dp)} MHz`;
    }
    if (hz >= 1e3) return `${(hz / 1e3).toFixed(hz % 1e3 === 0 ? 0 : 1)} kHz`;
    return `${hz} Hz`;
}

// Width a frequency label needs before it touches its neighbour: "14.075 MHz"
// in the 10px mono the axis uses, plus a gap.
export const FREQ_LABEL_PX = 78;

// How many tick intervals to put between labels so they do not overlap in
// `widthPx`. A whole multiple of the tick step, and labels are then placed on
// multiples of that — so the labelled values are round numbers in their own
// right (10 MHz, 20 MHz) rather than every second tick counted from the left
// (5, 15, 25). 4 is in the list so a 25 kHz tick can label every 100 kHz.
export function freqLabelEvery(tickCount, widthPx) {
    if (!widthPx || tickCount < 2) return 1;
    const fits = Math.max(1, Math.floor(widthPx / FREQ_LABEL_PX));
    if (tickCount <= fits) return 1;
    for (const m of [2, 4, 5, 10, 20, 50]) {
        if (Math.ceil(tickCount / m) <= fits) return m;
    }
    return tickCount;
}

// Ticks across the frequency axis: { hz, pct, label }, pct being 0–100 across
// the image. Edge ticks are dropped — a label half off the image reads as a
// mistake, and the range is stated next to the picture anyway.
//
// `label` is null on a tick that is drawn as a line but not labelled, which is
// how a narrow modal keeps its axis readable: at 25 kHz steps a 20m recorder
// has fourteen ticks and room for four labels, and the alternative to dropping
// ten of them is printing them on top of each other. Pass no width and every
// tick is labelled.
export function freqTicks(startHz, endHz, widthPx) {
    const span = endHz - startHz;
    if (!(span > 0)) return [];
    const step = freqTickStep(span);
    const first = Math.ceil(startHz / step) * step;
    const ticks = [];
    for (let hz = first; hz <= endHz; hz += step) {
        const pct = ((hz - startHz) / span) * 100;
        if (pct < 2 || pct > 98) continue;
        ticks.push({ hz, pct, label: formatTickHz(hz) });
    }
    const every = freqLabelEvery(ticks.length, widthPx);
    if (every > 1) {
        const labelStep = step * every;
        let any = false;
        for (let i = 0; i < ticks.length; i++) {
            if (ticks[i].hz % labelStep === 0) { any = true; continue; }
            ticks[i] = { ...ticks[i], label: null };
        }
        // A short range can contain no multiple of the label step at all. One
        // label in the middle beats an axis of unexplained lines.
        if (!any && ticks.length) {
            const mid = Math.floor(ticks.length / 2);
            ticks[mid] = { ...ticks[mid], label: formatTickHz(ticks[mid].hz) };
        }
    }
    return ticks;
}

// Hour spacing for the time axis: the coarsest that still gives a handful of
// labels, matching the row-spectrum chart in spectrogram.html.
export function timeTickStepMinutes(rowCount) {
    for (const h of [1, 2, 3, 4, 6, 8, 12, 24]) {
        if (Math.floor(rowCount / 60 / h) <= 12) return h * 60;
    }
    return 24 * 60;
}

// Ticks down the time axis: { pct, label } with pct 0–100 top to bottom, top
// being the oldest row. One row is one minute, so a tick is snapped to a clean
// clock boundary in minute-of-day space and converted back to a row.
export function timeTicks(rows, rowCount) {
    const n = rowCount || (rows ? rows.length : 0);
    if (!n) return [];
    const step = timeTickStepMinutes(n);
    const firstUnix = rows && rows[0] && rows[0].unix;
    if (!firstUnix) return [];

    const mod0 = Math.floor(firstUnix / 60) % 1440; // minute-of-day of row 0
    const ticks = [];
    for (let mod = Math.ceil(mod0 / step) * step; mod < mod0 + n; mod += step) {
        const row = mod - mod0;
        if (row < 0 || row >= n) continue;
        const pct = (row / n) * 100;
        if (pct > 99) continue;
        const hh = String(Math.floor((mod % 1440) / 60)).padStart(2, '0');
        const mm = String(mod % 60).padStart(2, '0');
        ticks.push({ pct, label: `${hh}:${mm}` });
    }
    return ticks;
}

// ── Cursor readout ───────────────────────────────────────────────────────────

// What the pointer is over, as a frequency and a UTC time. Fractions are 0–1
// across and down the image, which is what a pointer position over an <img>
// gives directly — the image is drawn at one scale, so nothing else is needed.
//
// Decimals follow the recorder's bin width rather than being fixed: a wideband
// bin is 7.3 kHz and three decimals is already more than it can tell you, while
// a per-band recorder at 100 Hz deserves four. Constant for a given view, so
// the readout does not change width as the pointer moves.
export function pointReadout(meta, xFrac, yFrac) {
    if (!meta) return null;
    const start = meta.start_freq_hz || 0;
    const span = (meta.end_freq_hz || 0) - start;
    const rows = meta.row_count || (meta.rows ? meta.rows.length : 0);
    if (!(span > 0) || !rows) return null;

    const x = Math.min(1, Math.max(0, xFrac));
    const y = Math.min(1, Math.max(0, yFrac));

    const hz = start + x * span;
    const dp = (meta.bin_width_hz || 0) >= 1000 ? 3 : 4;

    const row = Math.min(rows - 1, Math.floor(y * rows));
    const meta0 = meta.rows && meta.rows[row];
    let unix = meta0 && meta0.unix;
    if (!unix) {
        const first = meta.rows && meta.rows[0] && meta.rows[0].unix;
        unix = first ? first + row * 60 : 0;
    }

    let time = (meta0 && meta0.utc_time) || '';
    if (unix) {
        const d = new Date(unix * 1000);
        time = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    }

    return {
        hz,
        row,
        freq: `${(hz / 1e6).toFixed(dp)} MHz`,
        // Which day it is matters on a rolling window: the top of the image is
        // yesterday.
        time: time ? `${time} UTC` : '',
        ago: agoLabel(rows - 1 - row),
    };
}

// How long ago that row is, in the shape people say it: one row is one minute.
export function agoLabel(minutesAgo) {
    if (!(minutesAgo > 0)) return 'now';
    if (minutesAgo < 60) return `${minutesAgo} min ago`;
    const h = Math.floor(minutesAgo / 60);
    const m = minutesAgo % 60;
    return m ? `${h} h ${m} min ago` : `${h} h ago`;
}

// Where to put the readout relative to the point it describes.
//
// A mouse pointer is a few pixels of arrow and the tip can sit below-right of
// it. A fingertip is not: it covers the thing it just tapped, so on touch the
// tip always goes above, where it can be read while the finger is still down.
// Near the right or bottom edge it flips the other way rather than being
// clamped, so it stays attached to the point it is describing.
// Near the top there is nowhere above to go: a tip flipped up there hangs off
// the picture, and the modal scrolls to reach it — another size change under a
// pointer that was pointing at something.
const TIP_TOP_PCT = 12;

export function tipPlacement(pointerType, xPct, yPct) {
    const touch = pointerType !== 'mouse';
    return {
        left: xPct > 60,
        above: (touch || yPct > 80) && yPct > TIP_TOP_PCT,
    };
}

// Whether losing the pointer should clear the readout.
//
// A mouse leaving the picture has stopped asking. A finger lifting has not —
// the tap was the question, and clearing on pointerup would make the answer
// flash up and vanish, which is what a tap does if you treat it as a hover.
export function readoutClearsOn(pointerType) {
    return pointerType === 'mouse';
}
