// One band's live spectrum, as band_activity.html draws it.
//
// The server keeps a dedicated FFT per configured band — 40m at 500 Hz a bin
// rather than the 7.3 kHz a 0–30 MHz view can afford — and streams it over SSE
// as uint8 frames. That is a different picture from the main waterfall, which is
// the whole spectrum at whatever the zoom allows, and it is the one that shows
// a band as a band: every FT8 signal separated, the whole 200 kHz at once.
//
// This is the arithmetic, kept out of the panel so it can be tested: the wire
// format, the auto-range walk, and the dB scale the two share. The drawing is in
// BandSpectrumPanel.jsx.

// dBFS from the wire's uint8. The encoder maps the whole scale into a byte with
// 0 as its hard floor — those are not measurements, see AUTO floor filtering.
export const BYTE_FLOOR_DB = -256;

export function dbFromByte(v) {
    return v - 256;
}

export function configUrl() {
    return '/api/noisefloor/config';
}

// One band at a time. The endpoint takes several, and band_activity.html asks
// for every card it is showing; a panel showing where the dial is needs one, and
// asking for more would be a stream per band nobody is looking at.
export function streamUrl(band) {
    return `/api/noisefloor/spectrum/stream?band=${encodeURIComponent(band)}`;
}

// What the band stream is costing, bytes per second, or null when it is not
// running.
//
// A module-level reading rather than something passed around: the panel already
// measures it for its own readout, and the spectrum's stats overlay wants to add
// it to the session total — and those two are in different corners of the tree
// with no relationship worth inventing one for. Null when the panel is closed,
// which is also when the stream is closed: this panel is unmounted whenever its
// section is collapsed or hidden, so there is nothing to report.
let liveRate = null;

export function reportBandRate(bps) {
    liveRate = Number.isFinite(bps) && bps >= 0 ? bps : null;
}

export function bandRate() {
    return liveRate;
}

// The band to show: whichever one has been pinned, or the one the dial is in.
//
// A pin the receiver no longer records — a band dropped from its config since
// the choice was saved — falls back to following the dial rather than showing
// an empty panel for a band that is not there.
// v1's band activity page: every band the receiver records, side by side, over hours.
// This panel is one band now; that page is the whole picture over time, which is a
// different question and a page-sized answer to it.
export const ACTIVITY_URL = '/band_activity.html';

export const AUTO_BAND = 'auto';

export function chosenBand(choice, bands, dialBand) {
    if (choice && choice !== AUTO_BAND && bands && bands[choice]) return choice;
    return dialBand || null;
}

// The bands a picker should offer, up the spectrum — the order they are read in.
export function bandList(bands) {
    return Object.values(bands || {})
        .filter((b) => b && b.name)
        .sort((a, b) => (a.start || 0) - (b.start || 0));
}

// The bands the receiver runs a dedicated FFT for, from /api/noisefloor/config.
// Keyed by name, which is what bandForFrequency() gives.
export function bandsFromConfig(cfg) {
    const out = {};
    for (const b of (cfg && cfg.bands) || []) {
        if (b && b.name) out[b.name] = b;
    }
    return out;
}

// ── Wire format ──────────────────────────────────────────────────────────────
//
// A "SPEC" frame, base64 in the SSE data field: 22 bytes of header, then either
// every bin (flags 0x03) or a run of changed bins (0x04) as [idx_lo, idx_hi,
// value] triples behind a uint16 count. Delta frames are why the stream is
// affordable at 4 Hz — a quiet band changes a handful of bins between frames.

export const FRAME_FULL = 0x03;
export const FRAME_DELTA = 0x04;

export function decodeFrame(b64) {
    let bin;
    try {
        bin = atob(b64);
    } catch (e) {
        return null;
    }
    if (bin.length < 22) return null;
    if (bin[0] !== 'S' || bin[1] !== 'P' || bin[2] !== 'E' || bin[3] !== 'C') return null;

    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return { flags: buf[5], payload: buf.subarray(22) };
}

// Fold a frame into the bin array, returning the array to hold (a new one when
// the bin count changed) or null when the frame cannot be used — a delta with
// no full frame before it, or a full frame of the wrong width.
export function applyFrame(bins, frame, binCount) {
    if (!frame) return bins;
    const { flags, payload } = frame;

    if (flags === FRAME_FULL) {
        if (payload.length !== binCount) return bins;
        const next = (bins && bins.length === binCount) ? bins : new Uint8Array(binCount);
        next.set(payload);
        return next;
    }

    if (flags === FRAME_DELTA) {
        if (!bins) return null;                 // nothing to apply it to yet
        const count = payload[0] | (payload[1] << 8);
        for (let i = 0; i < count; i++) {
            const off = 2 + i * 3;
            if (off + 2 >= payload.length) break;
            const idx = payload[off] | (payload[off + 1] << 8);
            if (idx < bins.length) bins[idx] = payload[off + 2];
        }
        return bins;
    }

    return bins;
}

// ── Auto range ───────────────────────────────────────────────────────────────
//
// band_activity.html's algorithm, constants and all. The problem it solves is
// not "what range fits this frame" — that is two percentiles — but "what range
// can be left alone", because a scale that re-fits every frame makes the whole
// display breathe and a waterfall recoloured every second is unreadable.
//
// So: percentiles for the target, a long EMA to stop it chasing traffic, a
// deadband wider than the step so a move cannot re-trigger itself, a minimum
// interval, and one step at a time toward it. The escape hatch re-seeds when the
// scale is simply wrong rather than walking there over minutes.

export const AUTO_NOISE_PCT = 0.10;      // percentile taken as the noise floor
export const AUTO_SIGNAL_PCT = 0.995;    // percentile taken as the signal ceiling
export const AUTO_NOISE_MARGIN = 6;      // dB of scale left below the noise
export const AUTO_HEADROOM = 10;         // dB of scale left above the strongest signal
export const AUTO_EMA = 0.005;           // floor target — ≈50 s at 4 Hz
export const AUTO_EMA_UP = 0.06;         // ceiling attack — ≈4 s at 4 Hz
export const AUTO_EMA_DOWN = 0.004;      // ceiling release — ≈60 s at 4 Hz
export const AUTO_STEP = 2;              // applied values move in steps of this many dB
export const AUTO_DEADBAND = 3;          // target must drift this far to move it
export const AUTO_MIN_INTERVAL = 2000;   // ms — floor on how often the scale changes
export const AUTO_RESEED_DB = 24;        // ...but this far off means re-seed, not walk
export const AUTO_REVERSE_EXTRA = 2;     // extra deadband to reverse a recent move
export const AUTO_REVERSE_WINDOW_MS = 30000;
export const AUTO_SPAN_DEFAULT = 60;     // guaranteed minimum span, dB

export const MANUAL_DEFAULT = { min: -120, max: -60 };

export function createAutoRange() {
    return {
        min: null, max: null,            // applied, in whole AUTO_STEPs
        minEma: null, maxEma: null,      // smoothed targets
        minDir: 0, maxDir: 0,            // direction of the last move
        minMoveT: 0, maxMoveT: 0,
        lastChange: 0,
    };
}

// `sorted` is this frame's valid dBFS values, ascending. Returns true when the
// applied range moved, which is the caller's cue to recolour its history.
export function updateAutoRange(st, sorted, n, now) {
    if (!n) return false;
    const pct = (f) => sorted[Math.min(n - 1, Math.max(0, Math.round(f * (n - 1))))];

    // The floor is the anchor: placed just under the noise, then left alone.
    // Only the ceiling is tracked, so the minimum span (applied by rangeOf)
    // widens upward and can never drag the floor up.
    let tMin = pct(AUTO_NOISE_PCT) - AUTO_NOISE_MARGIN;
    tMin = Math.max(-160, Math.min(-40, tMin));
    const tMax = Math.min(0, pct(AUTO_SIGNAL_PCT) + AUTO_HEADROOM);

    if (st.minEma === null) {
        st.minEma = tMin;
        st.maxEma = tMax;
    } else {
        st.minEma += (tMin - st.minEma) * AUTO_EMA;
        st.maxEma += (tMax - st.maxEma) * (tMax > st.maxEma ? AUTO_EMA_UP : AUTO_EMA_DOWN);
    }

    // Seed on the first frame, so switching auto on shows no settling ramp.
    if (st.min === null) {
        st.min = Math.round(st.minEma / AUTO_STEP) * AUTO_STEP;
        st.max = Math.round(st.maxEma / AUTO_STEP) * AUTO_STEP;
        st.lastChange = now;
        return true;
    }

    if (now - st.lastChange < AUTO_MIN_INTERVAL) return false;

    // A target this far from the applied range means the scale is simply wrong
    // — a genuine large shift, or recovery after bad frames were smoothed in —
    // and walking there would be minutes of continuous jumping.
    if (Math.abs(st.minEma - st.min) >= AUTO_RESEED_DB
        || Math.abs(st.maxEma - st.max) >= AUTO_RESEED_DB) {
        st.min = Math.round(st.minEma / AUTO_STEP) * AUTO_STEP;
        st.max = Math.round(st.maxEma / AUTO_STEP) * AUTO_STEP;
        st.minDir = 0;                   // a snap is a fresh start, not a move
        st.maxDir = 0;                   // in a direction to be reversed
        st.lastChange = now;
        return true;
    }

    // One step toward the target. Continuing a walk needs the plain deadband,
    // reversing a recent one needs more, so the applied value cannot hop between
    // two lattice points off the back of a small periodic wobble.
    const step = (applied, ema, lastDir, lastT) => {
        const diff = ema - applied;
        const dir = Math.sign(diff);
        let band = AUTO_DEADBAND;
        if (dir !== 0 && dir === -lastDir && now - lastT < AUTO_REVERSE_WINDOW_MS) {
            band += AUTO_REVERSE_EXTRA;
        }
        if (Math.abs(diff) < band) return null;
        return { value: applied + dir * AUTO_STEP, dir };
    };

    let changed = false;
    const mMin = step(st.min, st.minEma, st.minDir, st.minMoveT);
    if (mMin) {
        st.min = mMin.value;
        st.minDir = mMin.dir;
        st.minMoveT = now;
        changed = true;
    }
    const mMax = step(st.max, st.maxEma, st.maxDir, st.maxMoveT);
    if (mMax) {
        st.max = mMax.value;
        st.maxDir = mMax.dir;
        st.maxMoveT = now;
        changed = true;
    }
    if (changed) st.lastChange = now;
    return changed;
}

// The range to draw with. Manual is the operator's two numbers; auto is this
// band's own walked range, falling back to the manual pair until it has a
// frame to work from. The minimum span is applied here rather than inside the
// smoothing, so changing it takes effect on the next frame without perturbing
// the EMA — and always widens upward.
export function rangeOf(auto, st, manual, minSpan = AUTO_SPAN_DEFAULT) {
    if (!auto || !st || st.min === null) {
        const lo = Math.min(manual.min, manual.max);
        const hi = Math.max(manual.min, manual.max);
        return { lo, hi: Math.max(hi, lo + 1) };
    }
    return { lo: st.min, hi: Math.max(st.max, st.min + minSpan) };
}

// Values at the encoder's hard floor are not measurements: they appear when the
// source has no data for a bin, and when a full-scale signal wraps the encoder.
// Feeding them into the percentiles drags the range toward −256 whenever such
// frames come and go — the "auto range gone mad" walk. A frame with almost no
// real bins updates nothing, and the last good range simply holds.
export function validValues(bins) {
    if (!bins || !bins.length) return null;
    const n = bins.length;
    const out = new Float32Array(n);
    let k = 0;
    for (let i = 0; i < n; i++) {
        const db = dbFromByte(bins[i]);
        if (db > BYTE_FLOOR_DB + 0.5) out[k++] = db;
    }
    if (k < 2 || k < n * 0.1) return null;
    const valid = out.subarray(0, k);
    valid.sort();
    return valid;
}

// ── Preferences ──────────────────────────────────────────────────────────────

const KEY = 'ubersdr.v2.bandspectrum';

export function savedPrefs() {
    const d = {
        auto: true, min: MANUAL_DEFAULT.min, max: MANUAL_DEFAULT.max, band: AUTO_BAND,
        // Whether the chart takes wheel and pinch gestures at all. On, because zooming is
        // most of what makes a band chart useful — but it is a chart inside a scrolling dock
        // column, so a wheel over it has two plausible meanings and only one of them can
        // win. Off gives the wheel back to the column.
        zoom: true,
    };
    try {
        const raw = JSON.parse(localStorage.getItem(KEY));
        if (!raw || typeof raw !== 'object') return d;
        return {
            auto: raw.auto !== false,
            min: Number.isFinite(raw.min) ? clampDb(raw.min) : d.min,
            max: Number.isFinite(raw.max) ? clampDb(raw.max) : d.max,
            band: typeof raw.band === 'string' && raw.band ? raw.band : d.band,
            zoom: raw.zoom !== false,
        };
    } catch (e) {
        return d;
    }
}

export function savePrefs(p) {
    try {
        localStorage.setItem(KEY, JSON.stringify({
            auto: !!p.auto,
            min: clampDb(p.min),
            max: clampDb(p.max),
            band: typeof p.band === 'string' && p.band ? p.band : AUTO_BAND,
            zoom: p.zoom !== false,
        }));
    } catch (e) { /* private mode */ }
}

export function clampDb(v) {
    return Math.max(-160, Math.min(0, Math.round(Number(v) || 0)));
}

// ── Reading the chart ────────────────────────────────────────────────────────
//
// Frequency comes from the band's own start/end, not from a bin index: bins are
// spaced (end − start) / n, and a reading taken as `binIndex × bin_bandwidth`
// drifts further off the true frequency the more bins there are. The dB value
// does come from a bin, because that is what a bin is.

export function hzAt(meta, xFrac) {
    const start = meta.start || 0;
    const span = (meta.end || 0) - start;
    const x = Math.min(1, Math.max(0, xFrac));
    return Math.round(start + x * span);
}

export function fracOfHz(meta, hz) {
    const start = meta.start || 0;
    const span = (meta.end || 0) - start;
    if (!(span > 0)) return 0;
    return (hz - start) / span;
}

export function binAt(binCount, xFrac) {
    if (!binCount) return 0;
    const x = Math.min(1, Math.max(0, xFrac));
    return Math.min(binCount - 1, Math.max(0, Math.round(x * (binCount - 1))));
}

// Which stored row a point down the waterfall is on. Rows are held oldest-first
// and drawn newest at the top, so y = 0 is the last row in the array.
export function rowAt(rowCount, yFrac, visibleRows) {
    if (!rowCount) return -1;
    const y = Math.min(1, Math.max(0, yFrac));
    const idx = Math.floor(y * (visibleRows || rowCount));   // 0 = newest on screen
    return rowCount - 1 - Math.min(rowCount - 1, idx);
}

// The 3 kHz FT8 window: the dial frequency the band is configured with, and the
// USB passband above it. A band without one configured reports 0.
export const FT8_SPAN_HZ = 3000;

export function ft8Window(meta) {
    const hz = (meta && meta.ft8_frequency) || 0;
    if (hz <= 0) return null;
    const start = fracOfHz(meta, hz);
    const end = fracOfHz(meta, hz + FT8_SPAN_HZ);
    if (end <= 0 || start >= 1) return null;      // configured, but outside this band
    return { hz, start, end };
}

export function formatMHz(hz) {
    return `${(hz / 1e6).toFixed(4)} MHz`;
}

export function formatDb(db) {
    return `${db.toFixed(1)} dBFS`;
}

export function formatAgeSec(sec) {
    if (!(sec > 0)) return 'now';
    if (sec < 60) return `${Math.round(sec)} s ago`;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return s ? `${m} min ${s} s ago` : `${m} min ago`;
}

// ── The frequency scale between the trace and the waterfall ──────────────────
//
// A thin strip, so the count comes from the width: a label is about seven
// monospace characters and needs room either side of it, and two labels touching
// is worse than one label fewer. Both ends are always ticks — the band's own
// edges are the two most useful numbers on the strip, and they are what tell you
// which band you are looking at.

// Room a label wants, including the gap to its neighbour.
export const SCALE_LABEL_PX = 70;
export const SCALE_MAX_TICKS = 5;

export function scaleTickCount(widthPx) {
    if (!widthPx) return 2;
    return Math.max(2, Math.min(SCALE_MAX_TICKS, Math.floor(widthPx / SCALE_LABEL_PX)));
}

// The fewest decimals that both tell the labels apart and state each tick
// exactly. Distinctness alone would print a 7.000–7.199 band as 7.0 / 7.1 / 7.2,
// which is a band edge that does not exist; exactness alone would print every
// band at five places on a 15 px strip. So 40m reads 7.0 / 7.1 / 7.2 and 20m —
// whose ticks land on 14.175 — reads 14.000 / 14.175 / 14.350.
export function scaleDecimals(values) {
    for (const dp of [1, 2, 3, 4, 5]) {
        const labels = values.map((hz) => (hz / 1e6).toFixed(dp));
        if (new Set(labels).size !== values.length) continue;
        const exact = labels.every((l, i) => Math.abs(parseFloat(l) * 1e6 - values[i]) < 1);
        if (exact) return dp;
    }
    return 5;
}

// Ticks across the strip: evenly spaced, both edges included. `align` says how
// the label sits against its tick — the end ones are pushed inward so they are
// readable rather than half off the panel.
export function scaleTicks(meta, widthPx) {
    const start = (meta && meta.start) || 0;
    const end = (meta && meta.end) || 0;
    if (!(end > start)) return [];

    const n = scaleTickCount(widthPx);
    const hzs = [];
    for (let i = 0; i < n; i++) hzs.push(start + ((end - start) * i) / (n - 1));
    const dp = scaleDecimals(hzs);

    return hzs.map((hz, i) => ({
        hz,
        pct: (i / (n - 1)) * 100,
        label: (hz / 1e6).toFixed(dp),
        align: i === 0 ? 'start' : i === n - 1 ? 'end' : 'center',
    }));
}

// ── Zoom ─────────────────────────────────────────────────────────────────────
//
// The window on the band, as a pair of fractions of it. band_activity.html's
// numbers: a wheel notch is 1.4×, and the tightest window is a hundredth of the
// band — 2 kHz of 40m, four bins of a 400-bin recorder, which is as far in as
// there is anything to see.

export const ZOOM_FACTOR = 1.4;
export const ZOOM_MIN_SPAN = 0.01;
export const FULL_ZOOM = { start: 0, end: 1 };

export function isZoomed(z) {
    return !!z && (z.end - z.start) < 0.999;
}

// Clamp a window to the band, keeping its width — a pan that runs off the end
// stops there rather than shrinking.
function settle(start, end) {
    let s = start;
    let e = end;
    if (s < 0) { e -= s; s = 0; }
    if (e > 1) { s -= (e - 1); e = 1; }
    return { start: Math.max(0, s), end: Math.min(1, e) };
}

// Zoom about a point, `at` being where it is in the *current* window (0–1). The
// frequency under that point does not move, which is what makes a wheel over a
// signal feel like it is pulling that signal closer rather than scrolling past.
export function zoomAt(z, at, factor) {
    const span = z.end - z.start;
    const next = Math.min(1, Math.max(ZOOM_MIN_SPAN, span / factor));
    const a = Math.min(1, Math.max(0, at));
    const anchor = z.start + a * span;      // the frequency that must not move
    const start = anchor - a * next;
    return settle(start, start + next);
}

// Shift the window by a fraction of *its own* width, so a step moves the same
// distance on screen however far in you are.
export function panByFraction(z, byWidths) {
    const span = z.end - z.start;
    const d = byWidths * span;
    return settle(z.start + d, z.end + d);
}

// Where the window sits in the band, in Hz.
export function zoomHz(meta, z) {
    const start = (meta && meta.start) || 0;
    const span = ((meta && meta.end) || 0) - start;
    return { start: start + z.start * span, end: start + z.end * span };
}

// The bins the window covers, as an inclusive range.
export function zoomBins(binCount, z) {
    if (!binCount) return { first: 0, last: 0, count: 0 };
    const first = Math.max(0, Math.min(binCount - 1, Math.round(z.start * (binCount - 1))));
    const last = Math.max(first + 1, Math.min(binCount - 1, Math.round(z.end * (binCount - 1))));
    return { first, last, count: last - first + 1 };
}

// A point in the window, back to a fraction of the whole band — and the reverse,
// for placing something whose position is known in band terms (the FT8 window).
export function bandFrac(z, viewFrac) {
    return z.start + viewFrac * (z.end - z.start);
}

export function viewFrac(z, frac) {
    const span = z.end - z.start;
    return span > 0 ? (frac - z.start) / span : 0;
}

// Where the receiver is listening, in fractions of the band: the dial and the
// passband either side of it. null when the dial is outside this band — the
// panel follows the dial, so that only happens in the moment between tuning
// away and the panel switching to the new band.
//
// The passband is taken as it comes rather than assumed to straddle the dial:
// an SSB filter is entirely on one side of it and LSB's is negative, so the two
// edges are sorted rather than added and subtracted.
export function dialWindow(meta, tuning) {
    if (!meta || !tuning) return null;
    const hz = Number(tuning.frequency);
    const start = meta.start || 0;
    const end = meta.end || 0;
    if (!Number.isFinite(hz) || !(end > start) || hz < start || hz > end) return null;

    const lo = Number(tuning.bandwidthLow) || 0;
    const hi = Number(tuning.bandwidthHigh) || 0;
    return {
        at: fracOfHz(meta, hz),
        start: fracOfHz(meta, hz + Math.min(lo, hi)),
        end: fracOfHz(meta, hz + Math.max(lo, hi)),
    };
}
