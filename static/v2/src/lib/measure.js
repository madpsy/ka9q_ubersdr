// The arithmetic behind the Measure panel: what a region drawn on the spectrum
// can honestly be said to contain.
//
// Pure, and separate from the panel and from the overlay, because none of it is
// drawing and all of it is the kind of thing that is wrong in ways a screenshot
// will not show — an integration that double-counts a bin, a −60 dB point that
// walked off the end of the selection and reported the edge as an answer, a
// centroid dragged to the middle of the box by the noise either side of the
// signal.
//
// ── What the numbers are in ──────────────────────────────────────────────────
//
// The bins arrive as 10·log10(power) with the receiver's configured gain added
// (user_spectrum.go), which is a *relative* dB scale: there is no calibration
// behind it and nothing here can invent one. So every absolute figure this
// produces — a peak level, an integrated power, a density — is dB on that
// scale and means something only next to another figure from the same receiver
// at the same moment.
//
// Everything that matters is a difference, and differences are exactly what the
// missing calibration cancels out of: SNR, the x-dB bandwidths, shape factor,
// occupied bandwidth, crest factor, flatness, and the spread of any of them
// over a run are all true statements regardless of where the zero is. That is
// why the panel leads with those and labels the rest "rel".
//
// One further offset is ignored on the same grounds. A bin is not a brick wall
// filter, so the power in it is the power in its equivalent noise bandwidth,
// which is the bin spacing times a window factor a little over one. The
// integrated power therefore carries a constant error of a fraction of a dB —
// constant, so it cancels in every ratio, and unknowable from here anyway since
// the window is radiod's.
//
// ── Where a bin is ───────────────────────────────────────────────────────────
//
// The frame is already rotated into ascending frequency order by the spectrum
// connection (_unwrap), so bin i is at centreFreq − span/2 + i·binBandwidth.
// That is deliberately the same mapping binsToPixels and the hover readout use:
// a measurement that disagreed with the picture it was drawn on would be worse
// than no measurement, however defensible its own arithmetic.
//
// The array's own length is taken as the bin count rather than view.binCount,
// because a frame that arrived a moment before the view state caught up is the
// normal case during a zoom and the two must not be mixed.

import { formatFreqExact, formatSpan } from './format.js';
import { findPeaks, interpolatePeak, noiseStats } from './spectrumPeaks.js';

/** dB to linear power, and back. Private: nothing outside needs the pair. */
const lin = (db) => Math.pow(10, db / 10);
const dbOf = (p) => (p > 0 ? 10 * Math.log10(p) : -Infinity);

// A view of part of the trace, without copying where the trace is typed. Tests
// hand these functions plain arrays, which have no subarray; a copy there costs
// nothing and a TypeError would cost a debugging session.
const part = (trace, lo, hi) => (trace.subarray ? trace.subarray(lo, hi) : trace.slice(lo, hi));

/**
 * The narrowest selection worth answering about.
 *
 * Four bins is not a considered minimum so much as the point below which the
 * answers stop being arithmetic: a median wants an odd number of samples to be
 * anything but an average, a parabolic peak needs a sample either side of the
 * maximum, and a width measured across three points is the resolution
 * bandwidth being reported back with extra steps. Below this the panel says
 * "too narrow at this zoom" — which is actionable, where a number would not be.
 */
export const MIN_BINS = 4;

/**
 * The x-dB bandwidths offered, and the ones drawn to begin with.
 *
 * These are the levels bench analysers and filter datasheets are written in and
 * not a set anybody chose here: −3 dB is half power, −6 dB is the one filter
 * skirts are quoted at, −20 and −26 dB are the emission-mask levels, and −60 dB
 * is the far skirt that pairs with −6 dB to make a shape factor.
 *
 * Three by default. All five is a picture with ten extra vertical lines in it,
 * and the two that are dropped are the ones that most often cannot be measured
 * at all: a −60 dB point needs sixty decibels of clean dynamic range below the
 * peak and inside the selection, which a busy band rarely offers.
 */
export const X_DB_LEVELS = [3, 6, 20, 26, 60];
export const DEFAULT_X_DB = [3, 6, 20];

/**
 * Occupied-bandwidth fractions, in percent.
 *
 * 99 % is the ITU definition and the default. 90 % is a good deal less
 * sensitive to how generously the region was drawn, which makes it the one to
 * reach for on a signal sitting in a raised noise pedestal; 99.9 % is for
 * looking at splatter, where the tails are the point.
 */
export const OBW_PERCENTS = [90, 99, 99.9];
export const DEFAULT_OBW = 99;

/**
 * How far above the noise floor counts as "occupied", in dB.
 *
 * Six decibels because that is roughly where a signal stops being arguable: MAD
 * puts a quiet band's peaks two or three sigma above the median, so a threshold
 * below that counts noise as occupancy and reports a dead frequency as busy
 * half the time.
 */
export const DEFAULT_OCCUPANCY_DB = 6;

/**
 * Standard FSK shifts, in Hz.
 *
 * Named so that a measured 172 Hz reads as "170 Hz (RTTY)" rather than as a
 * number the operator has to recognise. Anything not within tolerance of one of
 * these is reported as the bare measurement, which is the honest answer for the
 * many shifts that are nobody's standard.
 */
export const FSK_SHIFTS = [
    { hz: 85, name: 'narrow' },
    { hz: 170, name: 'RTTY' },
    { hz: 200, name: '200' },
    { hz: 425, name: '425' },
    { hz: 450, name: '450' },
    { hz: 850, name: 'wide' },
];

/** How far a measured shift may sit from a standard one and still be called it. */
const FSK_TOLERANCE = 0.08;

// ── frequency ↔ bin ─────────────────────────────────────────────────────────

/** The frequency of the lowest bin's centre, given how many arrived. */
function baseHz(view, n) {
    return view.centerFreq - (n * view.binBandwidth) / 2;
}

/** The centre frequency of bin `i` — fractional indices welcome. */
export function binToHz(view, n, i) {
    return baseHz(view, n) + i * view.binBandwidth;
}

/** The fractional bin index a frequency falls on. */
export function hzToBin(view, n, hz) {
    return (hz - baseHz(view, n)) / view.binBandwidth;
}

/**
 * The bins a selection covers: half-open `[lo, hi)`, clamped to the array.
 *
 * A bin is in when its *centre* is inside the selection, which is the only
 * definition under which drawing the same region twice at two zooms cannot
 * include a bin one time and not the other. Reversed selections are normalised
 * rather than refused: a drag right-to-left is the same region.
 */
export function binRange(view, n, sel) {
    if (!(view && view.binBandwidth > 0) || !(n > 0) || !sel) return null;
    const loHz = Math.min(sel.loHz, sel.hiHz);
    const hiHz = Math.max(sel.loHz, sel.hiHz);
    const lo = Math.max(0, Math.ceil(hzToBin(view, n, loHz)));
    const hi = Math.min(n, Math.floor(hzToBin(view, n, hiHz)) + 1);
    if (hi <= lo) return { lo, hi: lo, bins: 0 };
    return { lo, hi, bins: hi - lo };
}

// ── the selection, as it stands this frame ──────────────────────────────────

/**
 * Everything that can be read off one trace inside one region.
 *
 * `trace` is a frame's worth of bins in dB, ascending in frequency — the
 * averaged copy where the caller is averaging, since every level below the peak
 * is otherwise measured on whatever the noise did in that one frame.
 *
 * Returns null when there is nothing to answer: no view, no bins, or a
 * selection that has been zoomed down to fewer bins than MIN_BINS. Null rather
 * than a shape full of NaN, so a caller cannot render "NaN dB" by forgetting a
 * check.
 */
export function selectionStats(trace, view, sel) {
    if (!trace || !trace.length || !(view && view.binBandwidth > 0) || !sel) return null;
    const n = trace.length;
    const range = binRange(view, n, sel);
    if (!range || range.bins < MIN_BINS) return null;
    const { lo, hi, bins } = range;

    // One pass for the things a pass can do. The median and the sort it needs
    // are left to noiseStats, which is the estimator the peak markers already
    // use — one definition of "the floor" across the whole interface.
    let peakBin = lo;
    let maxDb = -Infinity;
    let minDb = Infinity;
    let sumDb = 0;          // the geometric mean, in dB, once divided
    let sumLin = 0;         // the arithmetic mean of power, once divided
    let counted = 0;
    for (let i = lo; i < hi; i++) {
        const v = trace[i];
        if (!Number.isFinite(v)) continue;
        counted++;
        if (v > maxDb) { maxDb = v; peakBin = i; }
        if (v < minDb) minDb = v;
        sumDb += v;
        sumLin += lin(v);
    }
    if (!counted) return null;

    // The peak, to better than a bin. Neighbours are taken from the array and
    // not from the selection: a peak sitting on the edge of the region is
    // usually a signal the region has clipped, and the sample just outside is
    // the best evidence there is about where it really is. `peakAtEdge` says so
    // out loud, because every width below is then a lower bound.
    const yl = trace[Math.max(0, peakBin - 1)];
    const yr = trace[Math.min(n - 1, peakBin + 1)];
    const fit = interpolatePeak(
        Number.isFinite(yl) ? yl : maxDb,
        maxDb,
        Number.isFinite(yr) ? yr : maxDb,
    );

    // The noise floor is the *view's*, not the region's, and that is the one
    // judgement call in this file worth arguing.
    //
    // The obvious reading is the median of the region, and it is wrong for the
    // way the region gets drawn. Somebody measuring a signal draws a box round
    // the signal — that is what the gesture is for — so most of the bins inside
    // it are the thing being measured, and its own median is then a couple of
    // decibels below its peak. Drawn tightly round a 40 dB carrier that reports
    // an SNR of 10, and drawn generously round the same carrier it reports 40:
    // a number that measures the gesture rather than the band.
    //
    // Estimated across the whole trace it is the noise floor of what is on
    // screen, which is what "signal to noise" means when anybody says it, and
    // it is the same estimator over the same data that the spectrum's own peak
    // markers use — so a peak labelled "+18 dB" on the display and the SNR in
    // this panel are the same statement rather than two that nearly agree.
    // Median and MAD make that robust to the other signals in view; a region
    // panned onto an empty patch of band still reads that patch's floor,
    // because that is then most of what is on screen.
    //
    // What the region's own median *does* say is reported beside it, as the
    // median: on a busy region it is a reading of how much of the box is full.
    const { floor, sigma } = noiseStats(trace, n > 1024 ? 4 : 1);
    const { floor: median } = noiseStats(part(trace, lo, hi), bins > 1024 ? 4 : 1);

    const meanDb = dbOf(sumLin / counted);       // mean power per bin
    const powerDb = dbOf(sumLin);                // integrated over the region
    const widthHz = Math.abs(sel.hiHz - sel.loHz);

    return {
        lo,
        hi,
        bins,
        rbw: view.binBandwidth,
        // The region as drawn, not as the bins rounded it: it is what the
        // operator asked for, and `bins` and `rbw` beside it say what the answer
        // could possibly resolve.
        loHz: Math.min(sel.loHz, sel.hiHz),
        hiHz: Math.max(sel.loHz, sel.hiHz),
        widthHz,
        centreHz: (sel.loHz + sel.hiHz) / 2,

        peakBin,
        peakHz: binToHz(view, n, peakBin + fit.delta),
        peakDb: fit.db,
        peakAtEdge: peakBin === lo || peakBin === hi - 1,

        floorDb: floor,
        sigmaDb: sigma,
        snrDb: fit.db - floor,
        // The middle of the region itself, which the floor above deliberately
        // is not.
        medianDb: median,

        maxDb,
        minDb,
        meanDb,
        powerDb,
        // Power per hertz. Equal to meanDb − 10·log10(rbw), which is the form
        // worth checking a change against: it must not depend on how wide the
        // region is, only on how loud it is.
        densityDb: powerDb - 10 * Math.log10(counted * view.binBandwidth),
        crestDb: fit.db - meanDb,
        // Geometric mean over arithmetic mean, which in dB is simply the mean of
        // the decibels minus the decibel of the mean power. Zero on a flat
        // trace; about −2.5 dB on Gaussian noise (that is −10·γ/ln10, and it is
        // the number to compare a reading against); far below that on anything
        // with a carrier in it.
        flatnessDb: sumDb / counted - meanDb,

        centroidHz: centroid(trace, view, n, range, floor),
    };
}

/**
 * The power-weighted centre of what is above the noise floor.
 *
 * Floor-subtracted, and that is the whole of why it is useful. A plain spectral
 * centroid over a hand-drawn region is dominated by the noise either side of
 * the signal, so it reports the middle of the box however the signal sits in it
 * — a number that moves when you redraw the region and not when the band
 * changes, which is the worst kind.
 *
 * Null when nothing in the region stands above the floor, which is the honest
 * answer for an empty patch of band.
 */
function centroid(trace, view, n, { lo, hi }, floorDb) {
    const base = lin(floorDb);
    let sum = 0;
    let weighted = 0;
    for (let i = lo; i < hi; i++) {
        const v = trace[i];
        if (!Number.isFinite(v)) continue;
        const p = lin(v) - base;
        if (p <= 0) continue;
        sum += p;
        weighted += p * i;
    }
    if (!(sum > 0)) return null;
    return binToHz(view, n, weighted / sum);
}

// ── bandwidths ──────────────────────────────────────────────────────────────

/**
 * The width of the signal `downDb` below its peak, walking out from the peak.
 *
 * Outward from the maximum and stopping at the *first* crossing, which is what
 * a bench analyser does and is the only rule that gives one answer on a lumpy
 * signal: a two-humped SSB envelope dips below −3 dB in the middle, and a rule
 * that took the outermost crossing would call that one signal at every level
 * while the first-crossing rule reports the hump the marker is on.
 *
 * The crossing itself is interpolated linearly in dB between the last bin above
 * the level and the first below it. That is worth doing rather than reporting
 * the bin: at a wide span one bin can be a third of the whole width, so
 * rounding to bins makes a −3 dB reading jump between two values as the signal
 * breathes, which looks like the signal moving.
 *
 * The walk is confined to the selection, so a region drawn too tightly reports
 * `clipped` and a width that is a lower bound. It is not silently widened to
 * the view: the region is the operator's statement about which signal is being
 * measured, and a −20 dB skirt that ran into the neighbouring carrier and kept
 * going would be a confident wrong answer.
 */
export function xDbBandwidth(trace, view, range, peakBin, peakDb, downDb) {
    if (!trace || !range || range.bins < MIN_BINS || !(downDb > 0)) return null;
    const { lo, hi } = range;
    if (peakBin < lo || peakBin >= hi) return null;
    const n = trace.length;
    const target = peakDb - downDb;
    // A peak that is already at or below its own target is not a peak with a
    // skirt; that happens when the trace has a hole in it, and no width follows.
    if (!(trace[peakBin] > target)) return null;

    const cross = (from, step) => {
        let prev = from;
        for (let i = from + step; i >= lo && i < hi; i += step) {
            const v = trace[i];
            if (!Number.isFinite(v)) continue;
            if (v <= target) {
                const above = trace[prev];
                // Equal samples either side would divide by zero; the crossing
                // is then at the bin itself, which is what the guard returns.
                const span = above - v;
                const frac = span > 0 ? (above - target) / span : 0;
                return { at: prev + step * frac, clipped: false };
            }
            prev = i;
        }
        // Ran out of selection still above the level.
        return { at: step < 0 ? lo : hi - 1, clipped: true };
    };

    const left = cross(peakBin, -1);
    const right = cross(peakBin, 1);
    const loHz = binToHz(view, n, left.at);
    const hiHz = binToHz(view, n, right.at);
    return {
        downDb,
        loHz,
        hiHz,
        widthHz: hiHz - loHz,
        clipped: left.clipped || right.clipped,
    };
}

/**
 * Shape factor: the ratio of the far skirt to the near one.
 *
 * The standard pairing is 60 over 6, and the number is how brick-wall the thing
 * being looked at is — 1 is a perfect filter and anything under about 2 is a
 * good one. Meaningful for a filter, a transmitter's mask, or an interferer you
 * are trying to name; meaningless for noise, which is why it is null unless
 * both widths were actually measured.
 *
 * A clipped width makes the ratio a bound rather than a value, and that is
 * passed on rather than hidden: a 60 dB width that ran into the edge of the
 * region understates the ratio, so the shape looks better than it is.
 */
export function shapeFactor(near, far) {
    if (!near || !far || !(near.widthHz > 0) || !(far.widthHz > 0)) return null;
    return { ratio: far.widthHz / near.widthHz, clipped: !!(near.clipped || far.clipped) };
}

/**
 * Occupied bandwidth: the narrowest span holding `percent` of the power, with
 * the remainder split equally above and below.
 *
 * The ITU definition, with one deliberate departure: the power is counted above
 * the measured noise floor rather than raw. Raw power is the textbook version
 * and it assumes a span containing the emission and not much else — draw the
 * region generously, as anybody drawing by hand does, and the noise pedestal
 * either side is most of the total, so the answer converges on the width of the
 * box. Subtracting the floor makes the reading a property of the signal and not
 * of how the region was drawn, which is the only way it can be compared with
 * the same reading taken a minute later.
 *
 * Null when nothing stands above the floor: an empty patch of band has no
 * occupied bandwidth, and reporting the width of the box for one would be the
 * exact failure above.
 */
export function occupiedBandwidth(trace, view, range, floorDb, percent) {
    if (!trace || !range || range.bins < MIN_BINS) return null;
    if (!(percent > 0) || !(percent < 100)) return null;
    const { lo, hi } = range;
    const n = trace.length;
    const base = lin(floorDb);

    const p = new Float64Array(hi - lo);
    let total = 0;
    for (let i = lo; i < hi; i++) {
        const v = trace[i];
        const above = Number.isFinite(v) ? lin(v) - base : 0;
        const value = above > 0 ? above : 0;
        p[i - lo] = value;
        total += value;
    }
    if (!(total > 0)) return null;

    const tail = (total * (100 - percent)) / 200;
    // Where the running sum first passes a threshold, interpolated across the
    // bin it happens in — the same reason the x-dB crossing is interpolated: at
    // a wide span one bin is a large share of the answer.
    const at = (want, fromEnd) => {
        let run = 0;
        for (let k = 0; k < p.length; k++) {
            const idx = fromEnd ? p.length - 1 - k : k;
            const v = p[idx];
            if (run + v >= want) {
                const frac = v > 0 ? (want - run) / v : 0;
                // Measured from the outer edge of the bin inwards, so a
                // threshold met immediately sits at the edge rather than at the
                // centre of the first bin holding power.
                return fromEnd ? idx + 0.5 - frac : idx - 0.5 + frac;
            }
            run += v;
        }
        // Never crossed, which floating point makes just possible at the
        // extremes: take the far edge in whichever direction was being walked.
        return fromEnd ? -0.5 : p.length - 0.5;
    };

    const loHz = binToHz(view, n, lo + at(tail, false));
    const hiHz = binToHz(view, n, lo + at(tail, true));
    return { percent, loHz, hiHz, widthHz: Math.max(0, hiHz - loHz) };
}

// ── two tones ───────────────────────────────────────────────────────────────

/**
 * The shift between the two strongest tones in the region, if there are two.
 *
 * For reading an FSK signal's shift off the waterfall, which is a thing an
 * operator does by eye and gets to within about fifty hertz. The peaks come
 * from the same finder the spectrum's own markers use, so "two tones" means
 * what it means everywhere else in this interface — prominent, above the floor,
 * not two shoulders of one hump.
 *
 * `gap` is in bins and is the finder's minimum separation. It is derived from
 * the resolution rather than fixed, because two tones 170 Hz apart are eighty
 * bins apart at one zoom and one bin apart at another, and at the second the
 * honest answer is that this cannot be measured here.
 */
export function fskShift(trace, view, range, { minGapBins = 3 } = {}) {
    if (!trace || !range || range.bins < MIN_BINS) return null;
    const { lo, hi } = range;
    const n = trace.length;
    const peaks = findPeaks(part(trace, lo, hi), {
        count: 2,
        gap: Math.max(2, minGapBins),
    });
    if (peaks.length < 2) return null;
    const tones = peaks
        .map((p) => ({ hz: binToHz(view, n, lo + p.x), db: p.db, snr: p.snr }))
        .sort((a, b) => a.hz - b.hz);
    const hz = tones[1].hz - tones[0].hz;
    if (!(hz > 0)) return null;
    const near = FSK_SHIFTS.find((s) => Math.abs(hz - s.hz) <= s.hz * FSK_TOLERANCE);
    return { hz, tones, standard: near || null };
}

// ── over the run ────────────────────────────────────────────────────────────
//
// Everything above is one frame. What follows is what makes the panel worth
// leaving running: the spread of each reading, and how often the region was
// busy at all. Kept as running sums rather than a list of every frame, because
// a session left going for an hour is tens of thousands of frames and none of
// them is worth keeping on its own.

/** A running min/max/mean/σ. Welford's, so σ does not lose precision over a long run. */
export function newSpread() {
    return { n: 0, min: Infinity, max: -Infinity, mean: 0, m2: 0 };
}

export function addSpread(s, v) {
    if (!Number.isFinite(v)) return s;
    s.n += 1;
    if (v < s.min) s.min = v;
    if (v > s.max) s.max = v;
    const d = v - s.mean;
    s.mean += d / s.n;
    s.m2 += d * (v - s.mean);
    return s;
}

/** The readable form: null where nothing has been counted. */
export function spreadOf(s) {
    if (!s || !s.n) return null;
    return {
        n: s.n,
        min: s.min,
        max: s.max,
        mean: s.mean,
        // Population σ, not the sample estimate: this is a description of the
        // frames that were seen, not an inference about frames that were not.
        sigma: Math.sqrt(s.m2 / s.n),
        range: s.max - s.min,
    };
}

/**
 * How much history the level trace keeps, in ms.
 *
 * Two minutes because the thing it is for is fading, and an HF fade has a
 * period of tens of seconds — ten seconds of chart (which is what the SNR trace
 * elsewhere shows) is a picture of one slope rather than of the cycle. Long
 * enough to count peaks, short enough that the array stays a few hundred
 * points at any frame rate the spectrum runs at.
 */
export const HISTORY_MS = 120000;

/**
 * How often a point is added to it.
 *
 * The spreads above are folded in on every frame, because a maximum that missed
 * frames would not be a maximum. The *chart* is a different question: it is a
 * few hundred pixels wide, so two minutes of twenty-frame-a-second history is
 * eight points per pixel — eight bezier segments drawn on top of each other,
 * several times a second, for a line that could not show the difference. Four
 * points a second fills the width and nothing more.
 */
export const HISTORY_EVERY_MS = 250;

export function newRun(nowMs) {
    return {
        startedAt: nowMs,
        frames: 0,
        occupied: 0,
        power: newSpread(),
        snr: newSpread(),
        peakDb: newSpread(),
        peakHz: newSpread(),
        floorDb: newSpread(),
        width: newSpread(),
        history: [],
    };
}

/**
 * Fold one frame's stats into the run.
 *
 * `width` is whichever bandwidth the panel is showing as the headline one, so
 * that its spread is over the same definition the operator is reading — passing
 * a −3 dB width one second and a −6 dB one the next would make the spread a
 * measure of the setting rather than of the signal. Null is fine and simply
 * does not count.
 *
 * Mutates and returns the run: it is called once per frame, and a copy per
 * frame of an object with six accumulators in it is work for nothing.
 */
export function accumulate(run, stats, nowMs, { occupancyDb = DEFAULT_OCCUPANCY_DB, width = null } = {}) {
    if (!run || !stats) return run;
    run.frames += 1;
    if (stats.snrDb >= occupancyDb) run.occupied += 1;
    addSpread(run.power, stats.powerDb);
    addSpread(run.snr, stats.snrDb);
    addSpread(run.peakDb, stats.peakDb);
    addSpread(run.peakHz, stats.peakHz);
    addSpread(run.floorDb, stats.floorDb);
    if (width && Number.isFinite(width.widthHz)) addSpread(run.width, width.widthHz);
    const last = run.history[run.history.length - 1];
    if (!last || nowMs - last.t >= HISTORY_EVERY_MS) {
        run.history.push({ t: nowMs, powerDb: stats.powerDb, snrDb: stats.snrDb });
        trimHistory(run, nowMs);
    }
    return run;
}

/**
 * Drop history that has scrolled out of the window, keeping one point beyond
 * it so the segment crossing the left edge still has somewhere to start — the
 * same rule, and the same reason, as lib/rollingChart.js's trimBefore.
 */
export function trimHistory(run, nowMs, spanMs = HISTORY_MS) {
    const cutoff = nowMs - spanMs;
    const h = run.history;
    let keep = 0;
    while (keep + 1 < h.length && h[keep + 1].t < cutoff) keep += 1;
    if (keep > 0) h.splice(0, keep);
    return h;
}

/**
 * The share of frames the region was busy for, 0..1, or null before any frame.
 *
 * Null and not zero on an empty run: "nothing has been measured" and "the
 * frequency was clear the whole time" are different statements, and only one of
 * them is worth acting on.
 */
export function occupancyOf(run) {
    if (!run || !run.frames) return null;
    return run.occupied / run.frames;
}

/**
 * How far the peak wandered, in Hz, or null if it was never found.
 *
 * The spread of the peak frequency, which is the measurement a drifting carrier
 * is looked at for. Reported as a range rather than a σ because drift is a walk
 * and not a scatter: after ten minutes the interesting number is how far it
 * went, not how variable it was about its mean.
 */
export function drift(run) {
    const s = spreadOf(run && run.peakHz);
    if (!s) return null;
    return { range: s.range, min: s.min, max: s.max, sigma: s.sigma };
}

// ── the gesture ─────────────────────────────────────────────────────────────

/**
 * What a press on the spectrum means while the tool is running.
 *
 * Three answers, and the order is the order a pointer can be aimed. An edge is
 * a line and is tested first; the inside of the region is an area and is tested
 * second; anything else starts a new region.
 *
 * The middle case is what makes a region feel like an object. Without it a
 * press inside the region you had just drawn would silently replace it, so a
 * measurement could only ever be started, never adjusted — and a region a pixel
 * out would have to be drawn again from scratch.
 *
 * An edge grab anchors on the *far* edge, so dragging one edge past the other
 * turns the region inside out rather than collapsing it to nothing. The store
 * normalises what comes back, which is why the gesture never has to.
 *
 * `grabHz` is how near an edge counts, in hertz — the caller converts its pixel
 * threshold, since only it knows how wide the view is on this screen.
 *
 * Here rather than in the spectrum because it is the one part of the gesture
 * that is a decision rather than plumbing, and because getting it wrong is
 * invisible until somebody tries to nudge an edge and redraws their
 * measurement instead.
 */
export function grabMode(sel, hz, grabHz) {
    if (!sel || !Number.isFinite(hz)) return { mode: 'new', anchor: hz };
    const lo = Math.min(sel.loHz, sel.hiHz);
    const hi = Math.max(sel.loHz, sel.hiHz);
    const grab = grabHz > 0 ? grabHz : 0;
    // Nearest edge first, so a region narrower than twice the threshold still
    // has two grabbable edges rather than one that always wins.
    const dLo = Math.abs(hz - lo);
    const dHi = Math.abs(hz - hi);
    if (dLo <= grab || dHi <= grab) {
        return dLo <= dHi ? { mode: 'edge', anchor: hi } : { mode: 'edge', anchor: lo };
    }
    if (hz > lo && hz < hi) return { mode: 'move', lo, hi };
    return { mode: 'new', anchor: hz };
}

// ── what one frame says ─────────────────────────────────────────────────────

/**
 * The part of a reading that is taken on every frame.
 *
 * Split from readingOf() below because the two are wanted at different rates. The
 * run's spread and its occupancy are folded in frame by frame — those are
 * statements about what the receiver actually sent, and sampling them would
 * make "busy 40 % of the time" a claim about the sampler — whereas the occupied
 * bandwidth, the shape factor and the tone search are for the screen, and the
 * screen is read five times a second.
 *
 * `headline` is the width the run's spread follows. One definition for the whole
 * run: accumulating a −3 dB width one second and a −6 dB one the next would make
 * the spread a measure of the setting rather than of the signal. The narrowest
 * level on offer, because that is the one measurable on the most signals — and
 * −6 dB when every level has been switched off, since the lines on the picture
 * and the figure in the panel are separate decisions and turning the first off
 * must not remove the second.
 */
export function frameStats(trace, view, sel, settings = {}) {
    const n = trace ? trace.length : 0;
    const range = n && sel ? binRange(view, n, sel) : null;
    const stats = selectionStats(trace, view, sel);
    if (!stats) return { stats: null, range, headline: null };
    const xDb = Array.isArray(settings.xDb) ? settings.xDb : DEFAULT_X_DB;
    const level = xDb.length ? Math.min(...xDb) : 6;
    return {
        stats,
        range,
        headline: xDbBandwidth(trace, view, range, stats.peakBin, stats.peakDb, level),
    };
}

/**
 * Everything the panel and the overlay are given, assembled from one trace.
 *
 * Here rather than in MeasureWatch so that the whole computation is one pure
 * function of (trace, view, region, settings) — which is the only way to check
 * that what the engine publishes is the shape the readout expects. The watcher
 * is then wiring: a socket, an average and a clock.
 *
 * `reason` is what to say when there is no reading, and it is three situations
 * that all look like an empty panel: the region has been panned off the view,
 * it has been zoomed down to fewer bins than anything can be measured across,
 * or no frame has arrived. Each has a different thing for the operator to do.
 *
 * `frame` is the per-frame half if it has already been computed for this trace,
 * so the publishing frame does not do that work twice.
 */
export function readingOf(trace, view, sel, settings = {}, run = null, at = Date.now(), frame = null) {
    const f = frame || frameStats(trace, view, sel, settings);
    const { stats, range } = f;
    const base = {
        at,
        rbw: view ? view.binBandwidth : 0,
        bins: range ? range.bins : 0,
        run,
        averageMs: settings.averageMs || 0,
    };

    if (!stats) {
        let reason = 'nodata';
        if (range) reason = range.bins === 0 ? 'outside' : 'narrow';
        return {
            ...base, reason, stats: null, widths: [], headline: null, obw: null, shape: null, fsk: null,
        };
    }

    const xDb = Array.isArray(settings.xDb) ? settings.xDb : DEFAULT_X_DB;
    const obwPercent = settings.obw != null ? settings.obw : DEFAULT_OBW;
    const width = (down) => xDbBandwidth(trace, view, range, stats.peakBin, stats.peakDb, down);
    return {
        ...base,
        reason: 'ok',
        stats,
        widths: xDb.map(width).filter(Boolean),
        headline: f.headline,
        obw: occupiedBandwidth(trace, view, range, stats.floorDb, obwPercent),
        // The shape factor's pair is measured whether or not those two levels
        // are being drawn: switching a line off the picture is a decision about
        // the picture, and the ratio is a number in the panel.
        shape: shapeFactor(width(6), width(60)),
        // Two tones only make sense where the resolution can tell them apart.
        // Three bins is the finder's own minimum separation; below that a shift
        // would be invented rather than measured.
        fsk: fskShift(trace, view, range, { minGapBins: 3 }),
    };
}

// ── the reading, as text ────────────────────────────────────────────────────

/**
 * The whole measurement as lines of plain text, for the Copy button.
 *
 * Here rather than in the panel because it is the one output of this feature
 * that leaves the browser. A measurement pasted into a log or an email is read
 * by somebody who cannot see the spectrum it came off, so every line has to
 * carry its own units and its own caveats — the "rel" on an uncalibrated level,
 * the ">" on a width that ran out of region, the sample count behind a spread.
 * That is a set of rules, and rules belong somewhere they can be tested.
 *
 * `at` is passed rather than read from the clock so the same reading always
 * produces the same text.
 */
export function reportLines(result, { tuning, at = Date.now() } = {}) {
    if (!result || !result.stats) return [];
    const s = result.stats;
    const out = [];
    const row = (label, value) => { if (value != null) out.push(`${label}: ${value}`); };
    const db = (v) => (Number.isFinite(v) ? `${v.toFixed(1)} dB` : null);

    out.push(`Measure ${new Date(at).toISOString().replace('T', ' ').slice(0, 19)}Z`);
    row('Region', `${formatFreqExact(s.loHz)} – ${formatFreqExact(s.hiHz)}`);
    row('Width', formatSpan(s.widthHz));
    row('Centre', formatFreqExact(s.centreHz));
    row('Resolution', `${formatSpan(result.rbw)}/bin over ${result.bins} bins`);
    if (result.averageMs) row('Averaging', `${(result.averageMs / 1000).toFixed(1)} s`);
    out.push('');

    row('Peak', `${formatFreqExact(s.peakHz)}  ${s.peakDb.toFixed(1)} dB rel${s.peakAtEdge ? '  (on the edge of the region — widths are lower bounds)' : ''}`);
    if (tuning && Number.isFinite(tuning.frequency)) {
        const off = s.peakHz - tuning.frequency;
        row('Peak vs dial', `${off >= 0 ? '+' : '−'}${formatSpan(Math.abs(off))}`);
    }
    if (s.centroidHz != null) row('Centroid', formatFreqExact(s.centroidHz));
    row('SNR', db(s.snrDb));
    row('Noise floor (this view)', `${s.floorDb.toFixed(1)} dB rel  (σ ${s.sigmaDb.toFixed(1)} dB)`);
    row('Region median', `${s.medianDb.toFixed(1)} dB rel`);
    row('Channel power', `${s.powerDb.toFixed(1)} dB rel`);
    row('Power density', `${s.densityDb.toFixed(1)} dB rel/Hz`);
    row('Crest', db(s.crestDb));
    row('Flatness', db(s.flatnessDb));
    out.push('');

    for (const w of result.widths || []) {
        row(`−${w.downDb} dB width`, `${w.clipped ? '>' : ''}${formatSpan(w.widthHz)}`);
    }
    if (result.obw) row(`Occupied bandwidth (${result.obw.percent}%)`, formatSpan(result.obw.widthHz));
    if (result.shape) {
        row('Shape factor (60/6)', `${result.shape.clipped ? '<' : ''}${result.shape.ratio.toFixed(2)}:1`);
    }
    if (result.fsk) {
        row('Tone spacing', `${Math.round(result.fsk.hz)} Hz${result.fsk.standard ? ` (${result.fsk.standard.hz} Hz ${result.fsk.standard.name})` : ''}`);
    }

    const run = result.run;
    const busy = occupancyOf(run);
    if (run && run.frames) {
        out.push('');
        row('Run', `${((at - run.startedAt) / 1000).toFixed(0)} s, ${run.frames} frames`);
        if (busy != null) row('Occupancy', `${(busy * 100).toFixed(0)}%`);
        const snr = spreadOf(run.snr);
        if (snr) row('SNR over the run', `${snr.min.toFixed(1)} – ${snr.max.toFixed(1)} dB, mean ${snr.mean.toFixed(1)}, σ ${snr.sigma.toFixed(1)}`);
        const d = drift(run);
        if (d && d.range > 0) row('Peak drift', formatSpan(d.range));
        const w = spreadOf(run.width);
        if (w && w.range > 0) row('Width over the run', `${formatSpan(w.min)} – ${formatSpan(w.max)}`);
    }

    out.push('');
    out.push('Levels are dB on the receiver\'s own uncalibrated scale; differences between them are absolute.');
    return out;
}
