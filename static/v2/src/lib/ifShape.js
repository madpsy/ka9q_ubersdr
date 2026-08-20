// The shape of a signal, from a short window of spectrum frames.
//
// The live trace is one measurement: every frame the noise moves several dB, so
// what you see is the signal plus a fresh draw from a random variable, and the
// eye is left to average it. This averages it properly instead, and draws what
// is left — the sustained level of every part of the window, with the spread
// around it. A carrier becomes a narrow spike with a tight band; speech becomes
// a broad hump with a wide one; a dead channel becomes a flat line with a band
// whose width *is* the noise. That is the picture a spectrum analyser draws in
// its averaging modes, and it is the one that answers "what is actually there"
// rather than "what arrived this frame".
//
// Three things have to be right for it to be worth trusting.
//
// ── The average is of power, not of decibels ─────────────────────────────────
//
// This is the one that is nearly always got wrong. Decibels are logarithmic, so
// the mean of a column of dB values is the *geometric* mean of the underlying
// powers, which is not the mean power and is systematically low — for
// Rayleigh-distributed noise it under-reads by about 2.5 dB, and the error
// depends on how noisy the bin is, so a weak signal and the noise beside it are
// pulled down by different amounts. That is a distortion of the shape itself,
// which is the one thing this view exists to show.
//
// So every sample is taken back to linear power, averaged there, and returned to
// dB. This is what an analyser calls RMS or power averaging, and it is the only
// average whose answer for "signal plus noise" is the sum of the two.
//
// The extremes are a different matter: min and max are order statistics, and
// dB→power is monotonic, so they are exactly the same points either way and are
// tracked in dB directly. No conversion, no rounding, no cost.
//
// ── The window is a length of time, not a number of frames ───────────────────
//
// Frames arrive at whatever rate the server, the zoom and the idle throttle
// leave them at — anywhere from twenty a second to two. A window of "the last 30
// frames" would therefore be a second and a half at one zoom and fifteen at
// another, and the display would change character when nothing about the signal
// had. Rows carry the time they arrived and the window is measured in
// milliseconds, so a two-second average is two seconds of signal whatever the
// feed is doing. The count that went into it is reported alongside, because a
// two-second average of three frames is a different quality of answer from one
// of forty, and the operator should be able to see which they have.
//
// ── The window is exact, not exponential ─────────────────────────────────────
//
// An IIR average is one multiply per bin and is what the main spectrum uses for
// its smoothing, which is the right trade there: it is a look, not a reading.
// Here it would be wrong twice. Its effective length depends on the frame rate
// it happens to be running at, which is the problem above wearing a disguise;
// and it has no min or max to give, because it does not keep the samples. This
// keeps them, so the mean is the true mean of a stated interval and the band is
// the true extent of it.
//
// The rows are held on the *offset* grid — resampled to a fixed width around the
// dial before they are stored, exactly as the waterfall's are — so tuning does
// not invalidate the history: a row means "this much power, this far from where
// I am listening", which stays true as the dial moves. The cost is that the
// samples are of the drawn window rather than of the receiver's raw bins, which
// is the right choice for a display and is stated here so it is not mistaken for
// a measurement of the bins themselves.
//
// ── Only the passband ────────────────────────────────────────────────────────
//
// The shape is of the *signal*, and the signal is what the filter is letting
// through. Everything outside the passband is a different station, or the noise
// between them, and drawing it here would be three separate things sharing a
// curve — the eye reads a continuous trace as one object. So the statistics stop
// at the filter edges and the pane draws nothing beyond them, which also makes
// the shaded passband mean something it never did on a live trace: it is the
// extent of what is being described.
//
// The mask is applied when the shape is computed rather than when the rows are
// stored. The rows are the window, the mask is the filter, and the filter can be
// shifted without the window changing — masking on the way in would leave the
// history describing an old filter with no way to tell.

// Width the rows are kept at. The window never holds more served bins than this
// — at the deepest zoom the interface offers, an SSB window is about 340 — so
// this is already a superset of the real resolution and a wider grid would be
// storing interpolation rather than detail.
export const SHAPE_BINS = 512;

// A ceiling on the rows kept, so a stalled clock or an absurd window cannot grow
// the history without bound. At the fastest feed and the longest window this is
// about a second clear of what is actually needed.
export const SHAPE_MAX_ROWS = 256;

// The averaging window the panel offers, in seconds.
export const SHAPE_SEC_MIN = 0.5;
export const SHAPE_SEC_MAX = 10;
export const SHAPE_SEC_DEFAULT = 2;

export function clampShapeSec(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return SHAPE_SEC_DEFAULT;
    return Math.min(SHAPE_SEC_MAX, Math.max(SHAPE_SEC_MIN, n));
}

export function createShape(bins = SHAPE_BINS) {
    return { bins, rows: [], free: [] };
}

/**
 * Throw the history away — a new x axis, so none of it describes this one.
 *
 * The rows are on the offset grid, so tuning is *not* such a change and must not
 * call this: that is the whole reason the grid is what it is. Changing the span,
 * the mode's window or the number of bins is.
 */
export function resetShape(st, bins) {
    if (bins > 0) st.bins = bins;
    // The buffers are recycled rather than dropped: this runs on every span
    // change, and a wheel is a span change per notch.
    for (const r of st.rows) st.free.push(r);
    st.rows.length = 0;
    if (st.free.length && st.free[0].v.length !== st.bins) st.free.length = 0;
    return st;
}

/**
 * Record one frame, and forget what has aged out of the window.
 *
 * `row` is dB on the offset grid — NaN where the served view had no bins, which
 * is carried through rather than counted, so a window that overhangs the
 * spectrum averages the part it has and reports nothing for the rest.
 */
export function pushShapeRow(st, row, nowMs, windowMs) {
    if (!row || !row.length) return st;
    if (row.length !== st.bins) resetShape(st, row.length);

    // Aged out at the front, which is where the oldest is: the rows are in
    // arrival order and time only runs one way.
    const cutoff = nowMs - Math.max(0, windowMs);
    while (st.rows.length && st.rows[0].at < cutoff) st.free.push(st.rows.shift());
    while (st.rows.length >= SHAPE_MAX_ROWS) st.free.push(st.rows.shift());

    const slot = st.free.pop() || { at: 0, v: new Float32Array(st.bins) };
    slot.at = nowMs;
    slot.v.set(row);
    st.rows.push(slot);
    return st;
}

/**
 * The passband as an inclusive range of grid bins: `{ first, last }`.
 *
 * `last < first` means the filter and the window do not overlap, which is
 * momentarily true while a mode change is in flight — the tuning arrives before
 * the window that was computed from it.
 *
 * The edges are taken as they come rather than assumed to straddle the dial: an
 * SSB filter is entirely on one side of it and LSB's is negative, so the two are
 * sorted rather than added and subtracted.
 */
export function bandBins(bins, win, tuning) {
    const empty = { first: 0, last: -1 };
    if (!bins || !win || !(win.span > 0) || !tuning) return empty;
    const a = Number(tuning.bandwidthLow) || 0;
    const b = Number(tuning.bandwidthHigh) || 0;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (!(hi > lo)) return empty;

    const perBin = win.span / bins;
    // Outward to whole bins, so a filter edge that falls inside a bin includes
    // it: the alternative shaves a bin off each side of every passband, which is
    // a systematic narrowing of the one thing being measured.
    const first = Math.floor((lo - win.offLo) / perBin);
    const last = Math.ceil((hi - win.offLo) / perBin) - 1;
    if (last < 0 || first > bins - 1) return empty;
    return { first: Math.max(0, first), last: Math.min(bins - 1, last) };
}

/**
 * The shape over the last `windowMs`: `{ mean, min, max, rows, spanMs }`.
 *
 * `mean` is the power average in dB, `min` and `max` the extremes in dB, all per
 * bin and all NaN where nothing in the window measured that bin — or where
 * `band` says the bin is outside the filter. `rows` is how many frames went in
 * and `spanMs` how much time they actually covered, which are the two numbers
 * that say how much the answer is worth.
 *
 * `band` is the range from bandBins(); omitting it describes the whole window.
 *
 * `out` is reused between calls; pass the object back in.
 */
export function shapeStats(st, windowMs, nowMs, out = {}, band) {
    const n = st.bins;
    if (!out.mean || out.mean.length !== n) {
        out.mean = new Float32Array(n);
        out.min = new Float32Array(n);
        out.max = new Float32Array(n);
        out.sum = new Float64Array(n);        // linear power, wide enough not to drift
        out.count = new Uint32Array(n);
    }
    const {
        mean, min, max, sum, count,
    } = out;
    sum.fill(0);
    count.fill(0);
    min.fill(Infinity);
    max.fill(-Infinity);

    // The bins worth looking at: the filter, or the whole window when no filter
    // was given. Everything outside is left at its zero count and comes out NaN,
    // so it is never averaged, never drawn, and never allowed into the levels.
    const first = band ? Math.max(0, band.first) : 0;
    const last = band ? Math.min(n - 1, band.last) : n - 1;

    const cutoff = nowMs - Math.max(0, windowMs);
    let rows = 0;
    let oldest = 0;
    let newest = 0;

    for (let r = 0; r < st.rows.length; r++) {
        const { at, v } = st.rows[r];
        // Rows are in arrival order, so the first one inside the window means
        // every one after it is too — but a window that has just been shortened
        // leaves older ones still in the ring, hence the test rather than a
        // binary search from the end.
        if (at < cutoff) continue;
        if (!rows) oldest = at;
        newest = at;
        rows++;
        for (let i = first; i <= last; i++) {
            const db = v[i];
            if (!Number.isFinite(db)) continue;
            // dB to linear power. The average has to happen here — see the note
            // at the top of this file for why averaging the decibels instead is
            // not the same number and not the right one.
            sum[i] += 10 ** (db / 10);
            count[i]++;
            if (db < min[i]) min[i] = db;
            if (db > max[i]) max[i] = db;
        }
    }

    for (let i = 0; i < n; i++) {
        if (!count[i]) {
            mean[i] = NaN;
            min[i] = NaN;
            max[i] = NaN;
            continue;
        }
        mean[i] = 10 * Math.log10(sum[i] / count[i]);
    }

    out.rows = rows;
    out.spanMs = rows > 1 ? newest - oldest : 0;
    return out;
}

// How few frames is too few to call it an average.
//
// Two is a pair of readings, not a shape; the band between them is whatever the
// noise happened to do twice. Below this the panel says how many it has rather
// than presenting the picture as settled.
export const SHAPE_MIN_ROWS = 4;

/** "2.0 s · 21 frames", or what is missing — for the readout under the chart. */
export function formatShape(stats, wantSec) {
    if (!stats || !stats.rows) return `${wantSec.toFixed(1)} s · filling`;
    const got = stats.spanMs / 1000;
    // The time actually covered, not the time asked for: a feed at two frames a
    // second cannot fill a half-second window, and saying "0.5 s" there would be
    // the one number on this line that was not measured.
    return `${got.toFixed(1)} s · ${stats.rows} frame${stats.rows === 1 ? '' : 's'}`;
}
