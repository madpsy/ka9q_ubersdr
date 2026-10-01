// Turning a complex baseband into something to listen to, or to measure.
//
// Each of these is the third stage of a demodulator in lib/iqDemod.js — what is
// left of a mode once the mixing and filtering, which every mode shares, are
// done. SSB and CW have no detector of their own here: theirs is a second
// oscillator and a real part, which is Nco.mixReal.

/** Power, |z|^2, per sample: what the squelch measures. */
export function complexPower(inI, inQ, out, frames) {
    for (let k = 0; k < frames; k++) {
        const i = inI[k];
        const q = inQ[k];
        out[k] = i * i + q * q;
    }
}

/**
 * The envelope, |z|: the AM detector.
 *
 * No translation needed — the magnitude is already real and already at
 * baseband, and the DC block downstream is what removes the carrier.
 */
export function envelope(inI, inQ, out, frames) {
    for (let k = 0; k < frames; k++) {
        const i = inI[k];
        const q = inQ[k];
        out[k] = Math.sqrt(i * i + q * q);
    }
}

/**
 * The FM discriminator: z[k] * conj(z[k-1]), whose argument is the phase
 * advanced in one sample, which is the instantaneous frequency.
 *
 * Scaled so that `deviationHz` comes out at 1. atan2 rather than the
 * small-angle shortcut because at 12 kHz a 3 kHz deviation is a radian and a
 * half per sample, where the approximation is not small and not an
 * approximation. The previous sample is carried between blocks.
 */
export class Discriminator {
    constructor({ deviationHz = 5000 } = {}) {
        this.deviationHz = deviationHz;
        this.lastI = 0;
        this.lastQ = 0;
    }

    reset() {
        this.lastI = 0;
        this.lastQ = 0;
    }

    process(inI, inQ, out, frames, rate) {
        const scale = this.deviationHz > 0 ? rate / (2 * Math.PI * this.deviationHz) : 0;
        let lastI = this.lastI;
        let lastQ = this.lastQ;
        for (let k = 0; k < frames; k++) {
            const fi = inI[k];
            const fq = inQ[k];
            const re = fi * lastI + fq * lastQ;
            const im = fq * lastI - fi * lastQ;
            lastI = fi;
            lastQ = fq;
            out[k] = (re === 0 && im === 0) ? 0 : Math.atan2(im, re) * scale;
        }
        this.lastI = lastI;
        this.lastQ = lastQ;
    }
}
