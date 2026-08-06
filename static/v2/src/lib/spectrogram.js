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

export function bandLabel(band) {
    if (band === 'wideband') return '0–30 MHz';
    if (band === DEFAULT_BAND) return '1.8–30 MHz';
    return band;
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

// Ticks across the frequency axis: { hz, pct, label }, pct being 0–100 across
// the image. Edge ticks are dropped — a label half off the image reads as a
// mistake, and the range is stated next to the picture anyway.
export function freqTicks(startHz, endHz) {
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
