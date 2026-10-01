// The spectrum of a real signal's recent past: a ring of the last `size`
// samples, transformed only when somebody asks.

import { fftInPlace, hannWindow } from '../iqSpectrum.js';

/**
 * Pushing is a copy of a few hundred floats a block; the transform runs only
 * when spectrum() is called, which the panel does once a frame and only for a
 * row that is open.
 */
export class SpectrumRing {
    constructor(size = 1024) {
        this.size = size;
        this.ring = new Float32Array(size);
        this.pos = 0;
        this.window = hannWindow(size);
        this.windowSum = this.window.reduce((a, b) => a + b, 0);
        this.re = null;
        this.im = null;
        this.db = null;
    }

    reset() {
        this.ring.fill(0);
        this.pos = 0;
    }

    push(buf, frames) {
        const ring = this.ring;
        const n = ring.length;
        let p = this.pos;
        for (let k = 0; k < frames; k++) {
            ring[p] = buf[k];
            p = p + 1 === n ? 0 : p + 1;
        }
        this.pos = p;
    }

    /**
     * dBFS per bin from DC to Nyquist, `rate / size` apart. The array is reused
     * between calls.
     */
    spectrum() {
        const n = this.size;
        if (!this.re) {
            this.re = new Float64Array(n);
            this.im = new Float64Array(n);
            this.db = new Float32Array(n / 2);
        }
        const { re, im, window: win } = this;
        let p = this.pos;
        for (let i = 0; i < n; i++) {
            re[i] = this.ring[p] * win[i];
            im[i] = 0;
            p = p + 1 === n ? 0 : p + 1;
        }
        fftInPlace(re, im);
        // A full-scale sine reads 0 dBFS: the window's coherent gain, and the
        // half of a real signal's power that lands in the negative bins.
        const norm = 2 / this.windowSum;
        const db = this.db;
        for (let k = 0; k < n / 2; k++) {
            const m = Math.hypot(re[k], im[k]) * norm;
            db[k] = m > 1e-9 ? 20 * Math.log10(m) : -180;
        }
        return db;
    }
}
