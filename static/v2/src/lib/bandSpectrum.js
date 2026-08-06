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
    const d = { auto: true, min: MANUAL_DEFAULT.min, max: MANUAL_DEFAULT.max };
    try {
        const raw = JSON.parse(localStorage.getItem(KEY));
        if (!raw || typeof raw !== 'object') return d;
        return {
            auto: raw.auto !== false,
            min: Number.isFinite(raw.min) ? clampDb(raw.min) : d.min,
            max: Number.isFinite(raw.max) ? clampDb(raw.max) : d.max,
        };
    } catch (e) {
        return d;
    }
}

export function savePrefs(p) {
    try {
        localStorage.setItem(KEY, JSON.stringify({
            auto: !!p.auto, min: clampDb(p.min), max: clampDb(p.max),
        }));
    } catch (e) { /* private mode */ }
}

export function clampDb(v) {
    return Math.max(-160, Math.min(0, Math.round(Number(v) || 0)));
}
