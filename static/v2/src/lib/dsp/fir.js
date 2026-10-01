// FIR design and the complex FIR filter.
//
// The filter every demodulator in lib/iqDemod.js is built round: a real-
// coefficient low-pass run over I and Q separately, which on a complex signal is
// a band-pass centred on zero that keeps one side of it apart from the other —
// see the header of lib/iqDemod.js for why that makes SSB easy here.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Bounds on the FIR length. The floor is what a 6 kHz AM filter needs to have
// any skirt at all; the ceiling is a cost limit, not a design one — 511 taps on
// a complex 12 kHz stream is about twelve million multiplies a second, which is
// a percent or two of one core and as far as this should go inside a WebSocket
// handler.
export const TAPS_MIN = 31;
export const TAPS_MAX = 511;

// Transition width, as a fraction of the cutoff, bounded either side.
//
// Proportional rather than fixed because the modes differ by two orders of
// magnitude: 400 Hz of skirt is nothing on a 6 kHz AM filter and is wider than
// the whole passband on a 250 Hz CW one. The floor stops a narrow filter asking
// for more taps than the ceiling above allows; the cap stops a wide one being
// needlessly soft.
export const TRANSITION_FRACTION = 0.2;
export const TRANSITION_MIN = 80;
export const TRANSITION_MAX = 400;

/**
 * How many taps a cutoff needs at this rate — odd, so the filter is symmetric.
 *
 * `transitionHz` overrides the proportional skirt, for a mode that needs a
 * particular one (ECSS, whose rejected sideband starts right at the carrier).
 */
export function tapsFor(cutoffHz, rateHz, transitionHz) {
    const transition = transitionHz > 0
        ? Math.max(TRANSITION_MIN, transitionHz)
        : clamp(Math.abs(cutoffHz) * TRANSITION_FRACTION, TRANSITION_MIN, TRANSITION_MAX);
    // The usual Blackman-window estimate: about 5.5 periods of the transition,
    // rounded here to 3.3 because the stopband this needs is the -74 dB the
    // window gives rather than anything tighter.
    const n = Math.round((3.3 * rateHz) / transition);
    return clamp(n | 1, TAPS_MIN, TAPS_MAX);
}

/**
 * A windowed-sinc low-pass, normalised to unity gain at DC.
 *
 * Blackman rather than Hamming: the stopband is 30 dB deeper for the same
 * length, and on a receiver the thing on the other side of the skirt is often
 * 40 dB louder than the thing being listened to. Normalising matters more than
 * it looks — without it the passband gain moves with the tap count, so changing
 * the filter width would change the volume.
 */
export function designLowpass(cutoffHz, rateHz, transitionHz) {
    const n = tapsFor(cutoffHz, rateHz, transitionHz);
    const taps = new Float32Array(n);
    const mid = (n - 1) / 2;
    // Never past Nyquist: a "cutoff" above it describes no filter at all, and
    // the sinc would alias into something that is not a low-pass.
    const fc = clamp(Math.abs(cutoffHz), 1, rateHz / 2 - 1) / rateHz;
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const x = i - mid;
        const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
        const w = 0.42
            - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
            + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
        const h = sinc * w;
        taps[i] = h;
        sum += h;
    }
    if (sum !== 0) for (let i = 0; i < n; i++) taps[i] /= sum;
    return taps;
}

/**
 * A real-coefficient FIR run over a complex signal: two convolutions, one on I
 * and one on Q, sharing a set of taps.
 *
 * The taps can be replaced without losing the history — a change of width
 * should sound like a filter changing, not like one starting — and the delay
 * line is only rebuilt when the length changes, because it has to be.
 */
export class ComplexFir {
    constructor() {
        this.taps = null;
        this.n = 0;
        this.bufI = null;
        this.bufQ = null;
        this.pos = 0;
    }

    setTaps(taps) {
        this.taps = taps;
        const n = taps.length;
        if (n !== this.n) {
            this.n = n;
            // Doubled, and every sample written twice: the convolution is then a
            // straight forward scan of n contiguous elements with no index
            // wrapping inside the inner loop, which is the loop that runs
            // twelve thousand times a second.
            this.bufI = new Float32Array(n * 2);
            this.bufQ = new Float32Array(n * 2);
            this.pos = 0;
        }
    }

    reset() {
        if (this.bufI) this.bufI.fill(0);
        if (this.bufQ) this.bufQ.fill(0);
        this.pos = 0;
    }

    /** Filter `frames` samples of inI/inQ into outI/outQ. */
    process(inI, inQ, outI, outQ, frames) {
        const n = this.n;
        const taps = this.taps;
        const bufI = this.bufI;
        const bufQ = this.bufQ;
        let pos = this.pos;
        for (let k = 0; k < frames; k++) {
            const mi = inI[k];
            const mq = inQ[k];
            bufI[pos] = mi;
            bufI[pos + n] = mi;
            bufQ[pos] = mq;
            bufQ[pos + n] = mq;
            pos = pos + 1 === n ? 0 : pos + 1;
            let fi = 0;
            let fq = 0;
            for (let t = 0; t < n; t++) {
                const h = taps[t];
                fi += h * bufI[pos + t];
                fq += h * bufQ[pos + t];
            }
            outI[k] = fi;
            outQ[k] = fq;
        }
        this.pos = pos;
    }
}
