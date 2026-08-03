// Live level per EQ band.
//
// A band's meter should answer "how much of what I am hearing does this slider
// control", which is not the same as "how much energy is near its centre": each
// band is a peaking biquad with a finite Q, so it reaches well past its centre
// frequency and overlaps its neighbours. Summing a fixed slice of bins per band
// would over-read narrow bands and under-read wide ones.
//
// So each bin is weighted by that filter's influence at that frequency. For a
// peaking filter the influence follows the bandpass prototype it is built from:
//
//     bp(f) = 1 / sqrt(1 + Q^2 * (f/f0 - f0/f)^2)
//
// which is 1 at the centre and 0.707 at the -3 dB points, where the band's
// width is f0/Q. Power is then averaged with w^2, since w is an amplitude.
//
// But bp's tails decay only as 1/(Q*ratio), and audio is nothing like flat: on
// speech, 500 Hz sits ~40 dB above 8 kHz, while its weight in the 8 kHz band is
// only -24 dB. The far-off energy therefore dominated that band's average, and
// every meter read roughly the same thing — boosting a band by 12 dB moved its
// own meter by about 1 dB, which is what made the display look broken while the
// audio plainly changed.
//
// So the response is gated: anything at or below the -6 dB point contributes
// nothing, rescaled so the centre still reads 1.
//
//     w(f) = clamp((bp(f) - 0.5) * 2, 0, 1)
//
// That leaves each band about an octave either side of its centre at Q=1 —
// enough overlap to be honest about neighbouring bands, with no far leakage. A
// +12 dB boost now moves its own meter by 12 dB.

// Weights are per (band set, Q, sample rate, bin count) and change only when
// the stream does, so they are built once and reused.
let cache = null;

export function bandWeights(freqs, q, sampleRate, binCount) {
    const key = `${freqs.join(',')}|${q}|${sampleRate}|${binCount}`;
    if (cache && cache.key === key) return cache.weights;

    const nyquist = sampleRate / 2;
    const weights = freqs.map((f0) => {
        const w = new Float32Array(binCount);
        for (let i = 0; i < binCount; i++) {
            // Bin centre. Bin 0 is DC, where the response is zero anyway.
            const f = ((i + 0.5) / binCount) * nyquist;
            const ratio = f / f0 - f0 / f;
            const bp = 1 / Math.sqrt(1 + q * q * ratio * ratio);
            w[i] = Math.max(0, Math.min(1, (bp - 0.5) * 2));
        }
        return w;
    });

    cache = { key, weights };
    return weights;
}

/**
 * Weighted level per band, in dBFS.
 *
 * `bins` is getFloatFrequencyData output (dB per bin). Bands whose centre is
 * above Nyquist — 8 kHz on a 12 kHz stream, say — have almost no weight on any
 * real bin and come out at the floor, which is correct: that audio is not there.
 */
export function bandLevels(bins, weights, out) {
    const levels = out && out.length === weights.length ? out : new Float32Array(weights.length);
    for (let b = 0; b < weights.length; b++) {
        const w = weights[b];
        let num = 0;
        let den = 0;
        for (let i = 0; i < w.length; i++) {
            const wi = w[i];
            if (wi <= 0) continue;                // outside this band entirely
            const db = bins[i];
            if (!Number.isFinite(db)) continue;
            const p = Math.pow(10, db / 10);      // dB -> power
            num += wi * wi * p;
            den += wi * wi;
        }
        levels[b] = den > 0 ? 10 * Math.log10(num / den) : -Infinity;
    }
    return levels;
}

// Maps band levels onto 0..1 for display, against a ceiling that follows the
// loudest band so the meters stay useful at any volume, with a fixed span so a
// quiet moment does not get amplified into a full-scale display.
export const METER_SPAN_DB = 45;

export function meterFractions(levels, state, span = METER_SPAN_DB) {
    let max = -Infinity;
    for (const v of levels) if (Number.isFinite(v) && v > max) max = v;
    if (Number.isFinite(max)) {
        // Rises quickly, falls slowly — a meter that drops as fast as it rises
        // reads as flicker.
        const rate = max > state.ceil ? 0.35 : 0.05;
        state.ceil += (max - state.ceil) * rate;
    }
    const floor = state.ceil - span;
    return Array.from(levels, (v) => {
        if (!Number.isFinite(v)) return 0;
        const t = (v - floor) / span;
        return t < 0 ? 0 : t > 1 ? 1 : t;
    });
}
