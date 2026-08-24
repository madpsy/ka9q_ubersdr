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
        for (let i = 0; i < n; i++) {
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

    // The noise floor, from the *whole* window and before the filter mask is
    // applied. The margin either side of the passband is usually the quietest
    // part of the picture and it is free; measured from the passband alone, a
    // channel full of signal would have no quiet quarter left to measure and the
    // floor would land inside the signal.
    if (!out.scratch || out.scratch.length !== n) out.scratch = new Float32Array(n);
    out.floorDb = noiseFloorOf(mean, out.scratch);

    // A copy of the mean before the mask, for the fit measurement
    // (lib/ifFit.js). Whether the signal continues past a filter edge is only
    // visible in the margins — the very bins the mask is about to erase — so
    // the masked array cannot answer it. Same reasoning as the floor above:
    // everything that needs the whole window reads it here, before the mask.
    if (!out.open || out.open.length !== n) out.open = new Float32Array(n);
    out.open.set(mean);

    // ...and only now the mask. Everything outside the filter is dropped rather
    // than drawn: see the note at the top of this file.
    if (band) {
        const first = Math.max(0, band.first);
        const last = Math.min(n - 1, band.last);
        for (let i = 0; i < n; i++) {
            if (i >= first && i <= last) continue;
            mean[i] = NaN;
            min[i] = NaN;
            max[i] = NaN;
        }
    }

    out.rows = rows;
    out.spanMs = rows > 1 ? newest - oldest : 0;
    return out;
}

// ── Driving the main display ─────────────────────────────────────────────────
//
// Every bin this view averages is one of the main spectrum's, so the quality of
// the shape is decided by a control on a different panel: the more the main
// display is zoomed in, the more bins land in the passband and the finer the
// shape. At the interface's deepest zoom an SSB passband holds a few hundred of
// them; at full span it holds a fraction of one.
//
// So the Shape view asks for the zoom it needs rather than waiting to be given
// it. That is a real intrusion — the main waterfall is shared, and something
// that moved it without being asked would be a panel reaching outside itself —
// which is why it is a switch, and why it fires on *entering* the view and on
// the window changing rather than continuously. Held continuously it could never
// be overruled: an operator zooming the main display out would watch it snap
// back, which is the worst behaviour a helpful default can have. Fired on entry,
// the last word is always theirs.

// How much wider than the window to ask for. Twice, so tuning inside the
// passband does not immediately walk the window off the edge of the view and
// spend a channel re-tune putting it back. For every mode narrower than about
// five kilohertz this lands on the interface's zoom floor anyway, which is as
// far in as it can go.
export const SHAPE_ZOOM_MARGIN = 2;

// ...and how far out the view has to be before it is worth moving. A view
// already close to what is wanted is left alone: the request costs a channel
// reload on the receiver, and one per panel switch is enough.
export const SHAPE_ZOOM_SLACK = 1.5;

/**
 * The span to ask the main display for, given the window being drawn.
 *
 * `floorSpan` is as far in as the interface's zoom will go — the span at its
 * narrowest bin width. Every mode below about five kilohertz wants less than
 * that, so this is what they all actually land on, and saying so here rather
 * than letting the request be silently clamped is what lets the test below know
 * when asking would change nothing.
 */
export function shapeZoomSpan(win, floorSpan = 0) {
    if (!win || !(win.span > 0)) return 0;
    return Math.max(win.span * SHAPE_ZOOM_MARGIN, floorSpan > 0 ? floorSpan : 0);
}

/**
 * Whether asking is worth the channel reload it costs.
 *
 * Two reasons to: the view is far wider than this window needs, or it does not
 * cover the window at all. The same request fixes both, because it sets the
 * centre as well as the span.
 *
 * Measured against where the request would actually *land*, not against what it
 * would ask for. On a narrow mode the wanted span is below the interface's zoom
 * floor and comes back clamped to it — so a view already sitting on that floor
 * is already the answer, and a test that compared against the unclamped figure
 * would send a reload every time the panel was opened to change nothing.
 */
export function shapeWantsZoom(cfg, win, coverage, floorSpan = 0) {
    if (!cfg || !(cfg.span > 0) || !win || !(win.span > 0)) return false;
    if (coverage < 1) return true;
    return cfg.span > shapeZoomSpan(win, floorSpan) * SHAPE_ZOOM_SLACK;
}

// ── Reading numbers off the shape ────────────────────────────────────────────
//
// Two questions the picture can be made to answer exactly rather than by eye:
// what the strongest thing in the passband is and where, and how much of the
// passband is occupied at all. Both are taken from the same time-averaged means
// the Shape view draws, which is what makes them steady — an instantaneous
// spectrum has a peak that hops between bins several times a second and an
// occupancy that flickers with every noise spike.
//
// Both are reported for every view, not only for Shape. The averaging is the
// measurement; the drawing is a separate question.

// A signal has to stand this far above the noise before it is called one. Six
// decibels on a two-second power average is well clear of what noise does on its
// own, and is about where a signal becomes audible.
export const SIGNAL_DB = 6;

// The percentile of the window taken as the noise floor.
//
// A percentile rather than a mean, because a mean of a passband with a signal in
// it is not the noise. Taken over the whole window rather than the passband
// alone: the margin either side of the filter is usually the quietest part of
// the picture, and it is free.
//
// Fifteen per cent, and the figure is set by that margin rather than picked for
// tidiness. The window is the filter and a quarter, so the part outside the
// filter is about a fifth of it — a little more on the narrow modes, where the
// minimum window widens things further. A percentile above that has no quiet
// bins left to land on the moment the passband fills up, and the floor rises
// into the signal: at a quarter, a full passband measured its own noise floor as
// thirty decibels too high and reported nothing occupied at all. Below the
// margin it always has somewhere honest to land.
//
// It costs almost nothing on a quiet passband. What is being ranked is a *power
// average over seconds*, not single frames, so the noise bins are within a few
// tenths of a decibel of each other and it makes little difference which of them
// is picked.
//
// The one case with no answer, stated because a single channel cannot do better:
// if the whole window is lifted — a wideband signal across all of it, or a noise
// floor that has risen everywhere — there is no quiet reference anywhere in the
// picture, and occupancy reads low because nothing stands out from anything.
export const NOISE_PCT = 0.15;

/** The noise floor of a row of averaged bins, in dB — NOISE_PCT of what is there. */
export function noiseFloorOf(mean, scratch) {
    const n = mean.length;
    const buf = scratch && scratch.length >= n ? scratch : new Float32Array(n);
    let k = 0;
    for (let i = 0; i < n; i++) if (Number.isFinite(mean[i])) buf[k++] = mean[i];
    if (!k) return NaN;
    const valid = buf.subarray(0, k);
    valid.sort();
    return valid[Math.min(k - 1, Math.round(NOISE_PCT * (k - 1)))];
}

/** What fraction of `band` stands SIGNAL_DB above the floor, 0..1. */
export function occupancyOf(mean, band, floorDb) {
    if (!band || band.last < band.first || !Number.isFinite(floorDb)) return null;
    const gate = floorDb + SIGNAL_DB;
    let total = 0;
    let busy = 0;
    for (let i = band.first; i <= band.last; i++) {
        if (!Number.isFinite(mean[i])) continue;
        total++;
        if (mean[i] > gate) busy++;
    }
    return total ? busy / total : null;
}

// How much better a candidate has to be before the peak moves to it.
//
// Without this the reading swaps between two signals of similar strength — or
// between two bins of one — every time the average tips one way, and a readout
// that alternates between two frequencies is worse than one that is a little
// slow. A decibel and a half is comfortably more than a settled average moves
// and far less than the gap between two signals worth telling apart.
export const PEAK_HOLD_DB = 1.5;

/**
 * The strongest point in the passband: `{ bin, offsetHz, db }`, or null.
 *
 * Null when nothing in the passband stands clear of the noise — which matters,
 * because the strongest *bin* of a channel containing only noise is a random
 * one and reporting it would be a frequency readout wandering over the whole
 * filter.
 *
 * The frequency is refined between bins by fitting a parabola through the peak
 * and its two neighbours, which is the standard estimator for a log-magnitude
 * spectrum and is what stops the reading stepping a whole bin at a time. It is
 * an estimate from the drawn grid, not a measurement of the receiver's own bins:
 * useful to a few hertz on a steady carrier, and no better than the resolution
 * behind it.
 *
 * `prev` is the last answer, for the hysteresis above; pass null to start again.
 */
export function measurePeak(mean, win, band, floorDb, prev) {
    if (!band || band.last < band.first || !win || !(win.span > 0)) return null;

    let best = -1;
    for (let i = band.first; i <= band.last; i++) {
        if (!Number.isFinite(mean[i])) continue;
        if (best < 0 || mean[i] > mean[best]) best = i;
    }
    if (best < 0) return null;
    if (Number.isFinite(floorDb) && mean[best] < floorDb + SIGNAL_DB) return null;

    // Hold the previous peak unless the new one is clearly better. Only where
    // the old bin is still in the passband and still has a reading: a filter
    // that has moved or narrowed takes its peak with it.
    let at = best;
    if (prev && prev.bin >= band.first && prev.bin <= band.last
        && Number.isFinite(mean[prev.bin])
        && mean[best] - mean[prev.bin] < PEAK_HOLD_DB) {
        at = prev.bin;
    }

    // Parabolic refinement, in dB. Guarded against the flat and the inverted
    // cases, where the fit has no maximum and would place the peak anywhere.
    let delta = 0;
    let db = mean[at];
    if (at > band.first && at < band.last) {
        const y0 = mean[at - 1];
        const y1 = mean[at];
        const y2 = mean[at + 1];
        const denom = y0 - 2 * y1 + y2;
        if (Number.isFinite(y0) && Number.isFinite(y2) && denom < 0) {
            delta = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom));
            db = y1 - 0.25 * (y0 - y2) * delta;
        }
    }

    const perBin = win.span / mean.length;
    return { bin: at, offsetHz: win.offLo + (at + 0.5 + delta) * perBin, db };
}

/**
 * Everything the readout shows, from one pass over the averaged shape.
 *
 * `state` carries the previous peak between calls, which is what the hysteresis
 * needs. Pass the same object back in.
 */
export function measureShape(stats, win, band, state = {}) {
    if (!stats || !stats.rows) {
        state.peak = null;
        return { peak: null, occupancy: null, floorDb: NaN, rows: 0 };
    }
    // Taken over the whole window before the mask, which is why shapeStats
    // works it out rather than this: by the time the arrays get here everything
    // outside the filter is already NaN.
    const { floorDb } = stats;
    const peak = measurePeak(stats.mean, win, band, floorDb, state.peak);
    state.peak = peak;
    return {
        peak,
        occupancy: occupancyOf(stats.mean, band, floorDb),
        floorDb,
        rows: stats.rows,
    };
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
