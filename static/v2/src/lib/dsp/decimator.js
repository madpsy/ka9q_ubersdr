// Mix, low-pass and keep every Dth sample: a wide stream brought down to the
// rate a demodulator needs.
//
// Nothing a demodulator listens to is wider than 12 kHz, but a wide IQ preset
// delivers 48 to 384 kHz of it. Running a demodulator's own filter on every one
// of those samples is the whole CPU budget, so this goes first: it mixes the
// passband of interest down to zero, filters with a short low-pass, and
// evaluates that filter only at the samples it keeps.

/**
 * The oscillator is a rotating phasor rather than a cos and a sin per sample —
 * at 384 kHz the trigonometry alone would be most of the cost — renormalised
 * once a block so rounding cannot grow it. The decimation count carries across
 * blocks, since a packet need not be a multiple of D.
 */
export class Decimator {
    constructor() {
        this.D = 1;
        this.frequencyHz = 0;
        this.taps = null;
        this.n = 0;
        this.bufI = null;
        this.bufQ = null;
        this.pos = 0;
        this.count = 0;
        this.rotRe = 1;
        this.rotIm = 0;
    }

    /**
     * New taps and a new factor. The delay line starts again, and so does the
     * count — a different filter's history is not this one's — but the
     * oscillator does not: it is the same oscillator at a new frequency.
     */
    setFilter(taps, D) {
        this.taps = taps;
        this.D = D;
        this.n = taps.length;
        this.bufI = new Float32Array(this.n * 2);
        this.bufQ = new Float32Array(this.n * 2);
        this.pos = 0;
        this.count = 0;
    }

    reset() {
        if (this.bufI) this.bufI.fill(0);
        if (this.bufQ) this.bufQ.fill(0);
        this.pos = 0;
        this.count = 0;
        this.rotRe = 1;
        this.rotIm = 0;
    }

    /**
     * Mix by -frequencyHz, filter and decimate `frames` samples at `inRate`
     * into outI/outQ, which must hold ceil(frames / D) + 1. Returns how many
     * were written.
     */
    process(inI, inQ, outI, outQ, frames, inRate) {
        const D = this.D;
        const n = this.n;
        const taps = this.taps;
        const bI = this.bufI;
        const bQ = this.bufQ;
        const step = (-2 * Math.PI * this.frequencyHz) / inRate;
        const sRe = Math.cos(step);
        const sIm = Math.sin(step);
        let pr = this.rotRe;
        let pi = this.rotIm;
        let pos = this.pos;
        let count = this.count;
        let m = 0;
        for (let k = 0; k < frames; k++) {
            const rawI = inI[k];
            const rawQ = inQ[k];
            const mi = rawI * pr - rawQ * pi;
            const mq = rawI * pi + rawQ * pr;
            const nr = pr * sRe - pi * sIm;
            pi = pr * sIm + pi * sRe;
            pr = nr;
            bI[pos] = mi;
            bI[pos + n] = mi;
            bQ[pos] = mq;
            bQ[pos + n] = mq;
            pos = pos + 1 === n ? 0 : pos + 1;
            if (++count < D) continue;
            count = 0;
            let fi = 0;
            let fq = 0;
            for (let t = 0; t < n; t++) {
                const h = taps[t];
                fi += h * bI[pos + t];
                fq += h * bQ[pos + t];
            }
            outI[m] = fi;
            outQ[m] = fq;
            m++;
        }
        const mag = Math.hypot(pr, pi) || 1;
        this.rotRe = pr / mag;
        this.rotIm = pi / mag;
        this.pos = pos;
        this.count = count;
        return m;
    }
}
