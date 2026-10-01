// Changing a signal's sample rate by a rational factor: L up, M down.
//
// The textbook polyphase resampler. Conceptually: put L−1 zeros between every
// input sample, low-pass at the lower of the two Nyquists, keep every Mth.
// Done literally that is L times the work for nothing — almost every product
// is a zero — so the filter is split into its L phases and each output sample
// is one phase's dot product with the most recent inputs, which is the same
// arithmetic with the zeros left out.
//
// The filter's gain is L, which is what puts back the energy the zeros spread.

import { hannWindow } from '../iqSpectrum.js';

// Ratios are approximated to keep L at or under this: the filter has L phases
// and it is held whole in memory.
export const MAX_L = 1024;
// Most taps a phase may have — the filter is this many input samples long,
// which on a deep decimation is what keeps the alias out.
const MAX_TAPS_PER_PHASE = 2048;

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/**
 * L/M for converting `inHz` to as near `outHz` as L ≤ MAX_L allows — exactly
 * for any pair of whole-hertz rates whose reduced ratio fits (44.1 to 48 kHz
 * is 160/147), and the closest fraction otherwise.
 */
export function resampleRatio(inHz, outHz) {
    const a = Math.round(inHz);
    const b = Math.round(outHz);
    if (a > 0 && b > 0) {
        const g = gcd(a, b);
        if (b / g <= MAX_L && a / g <= MAX_L * 64) return { L: b / g, M: a / g };
    }
    // Best rational approximation of out/in with L ≤ MAX_L, by continued
    // fractions.
    const x = outHz / inHz;
    let [h0, h1, k0, k1] = [0, 1, 1, 0];
    let v = x;
    for (let i = 0; i < 32; i++) {
        const q = Math.floor(v);
        const h2 = q * h1 + h0;
        const k2 = q * k1 + k0;
        if (h2 > MAX_L) break;
        [h0, h1, k0, k1] = [h1, h2, k1, k2];
        if (Math.abs(v - q) < 1e-12) break;
        v = 1 / (v - q);
    }
    return { L: Math.max(1, h1), M: Math.max(1, k1) };
}

/**
 * The prototype low-pass, as L phases of `taps` each, `phases[p][j]` being
 * h[p + j·L]. Cutoff at 45% of the lower rate, so a tenth of it is transition
 * band on the way to the alias.
 */
export function designResampler(L, M) {
    const lower = Math.min(1, L / M);          // lower rate as a fraction of the input's
    const taps = Math.min(MAX_TAPS_PER_PHASE, Math.ceil(34 / lower) | 1);
    const N = L * taps;
    const fc = (0.45 * lower) / L;             // cycles per sample at the upsampled rate
    const win = hannWindow(N);
    const h = new Float64Array(N);
    const mid = (N - 1) / 2;
    let sum = 0;
    for (let i = 0; i < N; i++) {
        const x = i - mid;
        const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
        h[i] = sinc * win[i];
        sum += h[i];
    }
    const phases = [];
    for (let p = 0; p < L; p++) {
        const ph = new Float64Array(taps);
        for (let j = 0; j < taps; j++) ph[j] = (h[p + j * L] * L) / sum;
        phases.push(ph);
    }
    return { phases, taps, delay: mid / L };
}

/**
 * One channel's resampler (two for a complex signal share a design). Carries
 * its history and its position between the input samples across blocks.
 */
export class Resampler {
    constructor(design, L, M) {
        this.d = design;
        this.L = L;
        this.M = M;
        this.buf = new Float64Array(design.taps * 2);
        this.pos = 0;
        this.phase = 0;
    }

    reset() {
        this.buf.fill(0);
        this.pos = 0;
        this.phase = 0;
    }

    /** Resample `n` of `input` into `out`. Returns how many were written. */
    process(input, out, n) {
        const { phases, taps } = this.d;
        const { L, M, buf } = this;
        let pos = this.pos;
        let phase = this.phase;
        let m = 0;
        for (let k = 0; k < n; k++) {
            const x = input[k];
            // Newest at the high end of the doubled line, oldest below it.
            buf[pos] = x;
            buf[pos + taps] = x;
            pos = pos + 1 === taps ? 0 : pos + 1;
            while (phase < L) {
                const h = phases[phase];
                let y = 0;
                // buf[pos + taps - 1] is the newest; h[j] pairs with the one j back.
                for (let j = 0; j < taps; j++) y += h[j] * buf[pos + taps - 1 - j];
                out[m++] = y;
                phase += M;
            }
            phase -= L;
        }
        this.pos = pos;
        this.phase = phase;
        return m;
    }
}
