// A second-order IIR section — the biquad — with the usual audio shapes.
//
// Coefficients from Robert Bristow-Johnson's "Audio EQ Cookbook", which is what
// almost every equaliser is built from. Five multiplies a sample, against the
// hundreds an FIR of the same sharpness takes, and no latency to speak of —
// which is what it trades for: the phase is not linear, so the delay varies
// with frequency, and steep shapes come from cascading them rather than from
// one.
//
//   lowpass, highpass   12 dB/octave beyond the corner; Q 0.707 is maximally
//                       flat (Butterworth)
//   bandpass            0 dB at the centre; Q is centre over bandwidth
//   notch               a null at the centre; Q is centre over the width
//   peaking             `gainDb` at the centre, Q wide
//   lowshelf, highshelf `gainDb` below or above the corner

export const BIQUAD_TYPES = ['lowpass', 'highpass', 'bandpass', 'notch', 'peaking', 'lowshelf', 'highshelf'];

/**
 * Normalised coefficients { b0, b1, b2, a1, a2 } for one shape at one rate.
 * The frequency is held inside (0, Nyquist) and Q above zero, so no setting
 * makes an unstable filter.
 */
export function biquadCoefficients(type, freqHz, q, gainDb, rateHz) {
    const f = Math.max(1, Math.min(rateHz / 2 - 1, freqHz));
    const Q = Math.max(0.01, q);
    const w0 = (2 * Math.PI * f) / rateHz;
    const cos = Math.cos(w0);
    const sin = Math.sin(w0);
    const alpha = sin / (2 * Q);
    const A = 10 ** (gainDb / 40);
    let b0;
    let b1;
    let b2;
    let a0;
    let a1;
    let a2;
    switch (type) {
        case 'highpass':
            b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
            a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
            break;
        case 'bandpass':
            b0 = alpha; b1 = 0; b2 = -alpha;
            a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
            break;
        case 'notch':
            b0 = 1; b1 = -2 * cos; b2 = 1;
            a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
            break;
        case 'peaking':
            b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A;
            a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
            break;
        case 'lowshelf': {
            const s = 2 * Math.sqrt(A) * alpha;
            b0 = A * ((A + 1) - (A - 1) * cos + s);
            b1 = 2 * A * ((A - 1) - (A + 1) * cos);
            b2 = A * ((A + 1) - (A - 1) * cos - s);
            a0 = (A + 1) + (A - 1) * cos + s;
            a1 = -2 * ((A - 1) + (A + 1) * cos);
            a2 = (A + 1) + (A - 1) * cos - s;
            break;
        }
        case 'highshelf': {
            const s = 2 * Math.sqrt(A) * alpha;
            b0 = A * ((A + 1) + (A - 1) * cos + s);
            b1 = -2 * A * ((A - 1) + (A + 1) * cos);
            b2 = A * ((A + 1) + (A - 1) * cos - s);
            a0 = (A + 1) - (A - 1) * cos + s;
            a1 = 2 * ((A - 1) - (A + 1) * cos);
            a2 = (A + 1) - (A - 1) * cos - s;
            break;
        }
        default: // lowpass
            b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
            a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
            break;
    }
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** Its magnitude response at `hz`, as a gain — for tests and for drawing it. */
export function biquadGainAt(c, hz, rateHz) {
    const w = (2 * Math.PI * hz) / rateHz;
    const re = (a, b, cc) => a + b * Math.cos(w) + cc * Math.cos(2 * w);
    const im = (b, cc) => -(b * Math.sin(w) + cc * Math.sin(2 * w));
    const nr = re(c.b0, c.b1, c.b2);
    const ni = im(c.b1, c.b2);
    const dr = re(1, c.a1, c.a2);
    const di = im(c.a1, c.a2);
    return Math.hypot(nr, ni) / Math.hypot(dr, di);
}

/**
 * One section, transposed direct form II: two state variables, kept in
 * doubles, carried between blocks — and kept across a change of settings, so
 * sweeping the frequency is a filter moving and not one restarting.
 */
export class Biquad {
    constructor() {
        this.c = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
        this.key = '';
        this.z1 = 0;
        this.z2 = 0;
    }

    configure(type, freqHz, q, gainDb, rateHz) {
        const key = `${type}/${freqHz}/${q}/${gainDb}/${rateHz}`;
        if (key === this.key) return;
        this.key = key;
        this.c = biquadCoefficients(type, freqHz, q, gainDb, rateHz);
    }

    reset() {
        this.z1 = 0;
        this.z2 = 0;
    }

    process(input, out, frames) {
        const { b0, b1, b2, a1, a2 } = this.c;
        let z1 = this.z1;
        let z2 = this.z2;
        for (let k = 0; k < frames; k++) {
            const x = input[k];
            const y = b0 * x + z1;
            z1 = b1 * x - a1 * y + z2;
            z2 = b2 * x - a2 * y;
            out[k] = y;
        }
        // A section fed silence decays into denormals, which on some CPUs cost
        // a hundred times a normal multiply. Flush them.
        this.z1 = Math.abs(z1) < 1e-30 ? 0 : z1;
        this.z2 = Math.abs(z2) < 1e-30 ? 0 : z2;
    }
}
