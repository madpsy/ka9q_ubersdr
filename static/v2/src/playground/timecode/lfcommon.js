// What the two 60 kHz amplitude decoders (wwvb.js, msf.js) have in common, as
// ubersdr-ntp's WwvbDecoder and MsfDecoder both have it: the 100 Hz envelope
// ring with its adaptive percentiles, the falling-edge test and the area
// estimate of where a drop sits inside its 10 ms block, a bank of complex DFT
// bins for finding a carrier, and how Source.cpp turns a voted minute and an
// edge into UTC. Only what is identical in both C++ files lives here; every
// constant the two tune differently (percentiles, contrast floors, window
// lengths) is a parameter, so neither decoder's tuning can move the other's.

import { civilFromDays, daysInMonth, fieldsFromUtc, utcFromFields } from './civil.js';

export const ENV_RATE_HZ = 100;   // the envelope series' rate
export const ENV_CAP = 1024;      // envelope ring capacity (> 10 s)
export const PCT_WIN = 300;       // adaptive-threshold window (3 s)

/**
 * The input-to-envelope decimation, which must be whole: the decoders' edge
 * arithmetic counts input samples per envelope block exactly.
 */
export function envelopeDecimation(sampleRate, who) {
    if (!(Number.isInteger(sampleRate) && sampleRate > 0 && sampleRate % ENV_RATE_HZ === 0)) {
        throw new Error(`${who}: sample rate ${sampleRate} Hz does not decimate to the ${ENV_RATE_HZ} Hz envelope `
            + `by a whole factor; give a multiple of ${ENV_RATE_HZ} Hz (12000 is the usual)`);
    }
    return sampleRate / ENV_RATE_HZ;
}

/**
 * The 100 Hz envelope: a ring by absolute index, with the lo/hi percentiles
 * of its last PCT_WIN samples recomputed on every push (nth_element's floor(q·n)
 * index, as the C++). Stored as float32, as the C++ stores it.
 */
export class Envelope {
    constructor(loQ, hiQ) {
        this.loQ = loQ;
        this.hiQ = hiQ;
        this.a = new Float32Array(ENV_CAP);
        this.scratch = new Float32Array(PCT_WIN);
        this.reset();
    }

    reset() {
        this.a.fill(0);
        this.count = 0;
        this.pLo = 0;
        this.pHi = 0;
    }

    // The C++ reads the ring modulo its size with no bounds check; the callers'
    // own bounds keep it inside the ring except right at the start, where a
    // look-back can reach before index 0 — read as 0 (the ring's initial fill)
    // rather than as whatever memory precedes the array.
    at(i) { return i < 0 ? 0 : this.a[i % ENV_CAP]; }

    push(v) {
        this.a[this.count % ENV_CAP] = v;
        this.count++;
        const n = Math.min(PCT_WIN, this.count);
        if (n < 8) { this.pLo = 0; this.pHi = 0; return; }
        const s = this.scratch.subarray(0, n);
        for (let k = 0, i = this.count - n; i < this.count; k++, i++) s[k] = this.a[i % ENV_CAP];
        s.sort();
        this.pLo = s[Math.floor(this.loQ * n)];
        this.pHi = s[Math.floor(this.hiQ * n)];
    }

    /** The 60 / 50 / 40 % levels between the percentiles the edge test uses. */
    thresholds() {
        const span = this.pHi - this.pLo;
        return { hi: this.pLo + 0.6 * span, mid: this.pLo + 0.5 * span, lo: this.pLo + 0.4 * span };
    }

    /**
     * A genuine second edge stays low for several envelope samples; a ~1-sample
     * notch (WWVB's BPSK flip transient) does not.
     */
    sustainedLow(i, thrLo) {
        let checked = 0;
        let low = 0;
        for (let d = 1; d <= 7; d++) {
            if (i + d >= this.count) break;
            checked++;
            if (this.at(i + d) < thrLo) low++;
        }
        return checked >= 5 && low >= checked - 1;
    }

    /**
     * The part of isFallingEdge both decoders share: env[i] is the first
     * sample below the midpoint, a full-carrier sample appears within the three
     * before it, and the drop is sustained.
     */
    fallingCross(i, t) {
        if (!(this.at(i - 1) >= t.mid && this.at(i) < t.mid)) return false;
        let high = false;
        for (let d = 1; d <= 3 && !high; d++) high = this.at(i - d) >= t.hi;
        return high && this.sustainedLow(i, t.lo);
    }

    /**
     * Sub-block position (a fractional envelope index) of the drop crossing at
     * env[i], by its area. A 10 ms block holding a step at fraction f averages
     * to L + f(H − L), so the step is in the sum of (env − L)/(H − L) over the
     * blocks spanning it, not in which block happens to cross a threshold. H is
     * the mean of env[i−8..i−4], L of env[i+4..i+loLast]; blocks i−2..i+3 cover
     * the step wherever the crossing rule can put it plus the low-pass's tail.
     * The caller turns it into input samples and takes the filter delay off.
     */
    areaPosition(i, loLast, minSpan) {
        let hi = 0;
        let lo = 0;
        for (let d = 4; d <= 8; d++) hi += this.at(i - d);
        for (let d = 4; d <= loLast; d++) lo += this.at(i + d);
        hi /= 5;
        lo /= loLast - 3;
        const span = hi - lo;
        if (!(span > minSpan)) return i;
        let area = 0;
        for (let k = i - 2; k <= i + 3; k++) area += (this.at(k) - lo) / span;
        return Math.min(i + 1.5, Math.max(i - 1.5, i - 2 + area));
    }
}

/**
 * Complex DFT bins at fixed frequencies, accumulated one sample at a time
 * (each bin a running e^{−j2πfn/fs}, renormalised every 1024 samples): the
 * carrier search, and MSF's live carrier-to-noise readout.
 */
export class DftBins {
    constructor(freqs, fs) {
        const n = freqs.length;
        this.f = Float64Array.from(freqs);
        this.stepRe = new Float64Array(n);
        this.stepIm = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            this.stepRe[i] = Math.cos((-2 * Math.PI * freqs[i]) / fs);
            this.stepIm[i] = Math.sin((-2 * Math.PI * freqs[i]) / fs);
        }
        this.rotRe = new Float64Array(n);
        this.rotIm = new Float64Array(n);
        this.accRe = new Float64Array(n);
        this.accIm = new Float64Array(n);
        this.reset();
    }

    get length() { return this.f.length; }

    reset() {
        this.rotRe.fill(1);
        this.rotIm.fill(0);
        this.accRe.fill(0);
        this.accIm.fill(0);
        this.count = 0;
    }

    push(xr, xi) {
        const { rotRe, rotIm, stepRe, stepIm, accRe, accIm } = this;
        for (let i = 0; i < rotRe.length; i++) {
            const cr = rotRe[i];
            const ci = rotIm[i];
            accRe[i] += xr * cr - xi * ci;
            accIm[i] += xr * ci + xi * cr;
            rotRe[i] = cr * stepRe[i] - ci * stepIm[i];
            rotIm[i] = cr * stepIm[i] + ci * stepRe[i];
        }
        if ((this.count & 1023) === 1023) {
            for (let i = 0; i < rotRe.length; i++) {
                const m = Math.hypot(rotRe[i], rotIm[i]);
                if (m > 1e-9) { rotRe[i] /= m; rotIm[i] /= m; }
            }
        }
        this.count++;
    }

    power(i) { return this.accRe[i] * this.accRe[i] + this.accIm[i] * this.accIm[i]; }

    powers() { return Array.from(this.f, (_, i) => this.power(i)); }
}

/** The element at index floor(n/2) of the sorted values (nth_element's median). */
export function upperMedian(values) {
    const a = Array.from(values).sort((x, y) => x - y);
    return a[a.length >> 1];
}

/** Whether Unix ms `ms` falls on the last day of its month (UTC). */
export function isLastDayOfMonth(ms) {
    const { y, m, d } = civilFromDays(Math.floor(ms / 86400000));
    return d === daysInMonth(y, m);
}

/**
 * The next UTC midnight after `ms` when `ms` falls on the last day of a month,
 * else −1: a leap second is inserted as 23:59:60 immediately before exactly
 * such a midnight, and nowhere else.
 */
export function leapBoundaryAfter(ms) {
    if (!isLastDayOfMonth(ms)) return -1;
    return (Math.floor(ms / 86400000) + 1) * 86400000;
}

/**
 * The certified time at `edge`, composed as Source.cpp's onClockTime does:
 * the voted fields name the last frame's second 0, and whole seconds of
 * samples from that frame's start edge are added. Null when the count would
 * cross a midnight a leap second could precede — the next frame starts after
 * it.
 */
export function composeUtc(fields, frameStartEdge, edge, fs) {
    const baseMs = utcFromFields(fields);
    const decoded = baseMs + Math.round((edge - frameStartEdge) / fs) * 1000;
    const boundary = leapBoundaryAfter(baseMs);
    if (boundary > 0 && decoded >= boundary) return null;
    return decoded;
}

/** The voter's plausibility reference from the README's `referenceNow` (Unix ms), or null. */
export function voterReference(referenceNow) {
    return typeof referenceNow === 'function' ? () => fieldsFromUtc(referenceNow()) : null;
}

/** The voter's numeric symbol as the README's event names it. */
export function symbolName(sym) {
    return sym === 0 ? 'zero' : sym === 1 ? 'one' : sym === 2 ? 'marker' : 'unknown';
}
