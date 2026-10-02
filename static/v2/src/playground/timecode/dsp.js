// The small DSP the time-code decoders share, as ubersdr-ntp's decoders have
// it (src/clock/): RBJ biquads in transposed direct form II, a phasor
// oscillator, and a percentile. Kept identical to the C++ — the decoders' tuned
// constants assume exactly these filters.

/** One biquad section. `lowpass` and `bandpass` (constant 0 dB peak) are RBJ's. */
export class Biquad {
    constructor(b0, b1, b2, a1, a2) {
        this.b0 = b0; this.b1 = b1; this.b2 = b2; this.a1 = a1; this.a2 = a2;
        this.z1 = 0; this.z2 = 0;
    }

    static lowpass(fc, fs, q = Math.SQRT1_2) {
        const w0 = (2 * Math.PI * fc) / fs;
        const cs = Math.cos(w0);
        const alpha = Math.sin(w0) / (2 * q);
        const a0 = 1 + alpha;
        return new Biquad(((1 - cs) / 2) / a0, (1 - cs) / a0, ((1 - cs) / 2) / a0, (-2 * cs) / a0, (1 - alpha) / a0);
    }

    static bandpass(f0, fs, q) {
        const w0 = (2 * Math.PI * f0) / fs;
        const cs = Math.cos(w0);
        const alpha = Math.sin(w0) / (2 * q);
        const a0 = 1 + alpha;
        return new Biquad(alpha / a0, 0, -alpha / a0, (-2 * cs) / a0, (1 - alpha) / a0);
    }

    process(x) {
        const y = this.b0 * x + this.z1;
        this.z1 = this.b1 * x - this.a1 * y + this.z2;
        this.z2 = this.b2 * x - this.a2 * y;
        return y;
    }

    reset() { this.z1 = 0; this.z2 = 0; }

    /** Group delay at DC, in samples (a lowpass's). */
    dcDelay() {
        return 1 - (this.a1 + 2 * this.a2) / (1 + this.a1 + this.a2);
    }

    clone() { return new Biquad(this.b0, this.b1, this.b2, this.a1, this.a2); }
}

// A 4th-order Butterworth as two RBJ sections.
export const BUTTER4_Q = [0.54119610014619698, 1.3065629648763766];

/** A cascade of sections run in turn. */
export class Cascade {
    constructor(sections) { this.s = sections; }
    process(x) { let y = x; for (const b of this.s) y = b.process(y); return y; }
    reset() { for (const b of this.s) b.reset(); }
    dcDelay() { return this.s.reduce((a, b) => a + b.dcDelay(), 0); }
    static butter4(fc, fs) { return new Cascade(BUTTER4_Q.map((q) => Biquad.lowpass(fc, fs, q))); }
    static repeat(make, n) { return new Cascade(Array.from({ length: n }, make)); }
}

/** The same filter on I and on Q. */
export class ComplexFilter {
    constructor(make) { this.i = make(); this.q = make(); }
    process(re, im) { return [this.i.process(re), this.q.process(im)]; }
    reset() { this.i.reset(); this.q.reset(); }
    dcDelay() { return this.i.dcDelay(); }
}

/**
 * e^{-j·2π·f·n/fs}, one sample at a time: a running phasor, renormalised
 * every 1024 steps so rounding cannot grow it.
 */
export class Rotator {
    constructor(hz, fs, sign = -1) {
        this.fs = fs;
        this.sign = sign;
        this.c = 1;
        this.s = 0;
        this.n = 0;
        this.set(hz);
    }

    set(hz) {
        this.hz = hz;
        const w = (this.sign * 2 * Math.PI * hz) / this.fs;
        this.dc = Math.cos(w);
        this.ds = Math.sin(w);
    }

    /** Advance, returning the phasor before the step: [cos, sin]. */
    step() {
        const c = this.c;
        const s = this.s;
        this.c = c * this.dc - s * this.ds;
        this.s = c * this.ds + s * this.dc;
        if (++this.n % 1024 === 0) {
            const m = Math.hypot(this.c, this.s) || 1;
            this.c /= m;
            this.s /= m;
        }
        return [c, s];
    }
}

/** The q-quantile of `values` (0..1), by index floor(q·n) into the sorted copy. */
export function quantile(values, q) {
    const a = Array.from(values).sort((x, y) => x - y);
    if (!a.length) return 0;
    return a[Math.min(a.length - 1, Math.max(0, Math.floor(q * a.length)))];
}

export function median(values) {
    return quantile(values, 0.5);
}

/** A ring of the last `cap` values, indexed by absolute position. */
export class Ring {
    constructor(cap, Type = Float64Array) {
        this.cap = cap;
        this.a = new Type(cap);
        this.count = 0;
    }

    push(v) { this.a[this.count % this.cap] = v; this.count++; }

    /** The value at absolute index i, or undefined if gone or not yet there. */
    at(i) {
        if (i < 0 || i >= this.count || i < this.count - this.cap) return undefined;
        return this.a[i % this.cap];
    }

    has(i) { return i >= 0 && i < this.count && i >= this.count - this.cap; }
}

/** Parabolic refinement of a peak at the middle of a, b, c: an offset in −0.5..0.5, 0 if not a peak. */
export function parabola(a, b, c) {
    const den = a - 2 * b + c;
    if (!(den < 0)) return 0;
    return Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
}
