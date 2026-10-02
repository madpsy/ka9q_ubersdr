// An HF channel simulator: the Watterson model, as ITU-R F.1487 tests HF
// modems with (and GNU Radio's channel models have it, gr-channels).
//
// The ionosphere returns a signal along more than one path. Here, two: equal
// in power, the second arriving `delayMs` later, each fading on its own — a
// complex Gaussian gain whose spectrum is a Gaussian `dopplerHz` wide (two
// standard deviations, as F.1487 defines the spread), so its envelope is
// Rayleigh and it comes and goes about as fast as the spread says. On top, an
// optional fixed frequency offset. Noise is the Noise source's business —
// wire one after this at the SNR wanted.
//
// The presets are F.1487's mid-latitude conditions:
//
//   Good       0.5 ms delay, 0.1 Hz Doppler spread
//   Moderate   1 ms,         0.5 Hz
//   Poor       2 ms,         1 Hz
//   Flutter    0.5 ms,       10 Hz   (an auroral, disturbed path)
//
// The fading gains are made at a low rate (well above the spread) by
// filtering white complex noise with a Gaussian, then interpolated to the
// stream's rate — the usual way, and cheap: the per-sample cost is a delay
// line and two complex multiplies.

import { COMPLEX } from '../block.js';

export const WATTERSON = {
    good: { label: 'Good (0.5 ms, 0.1 Hz)', delayMs: 0.5, dopplerHz: 0.1 },
    moderate: { label: 'Moderate (1 ms, 0.5 Hz)', delayMs: 1, dopplerHz: 0.5 },
    poor: { label: 'Poor (2 ms, 1 Hz)', delayMs: 2, dopplerHz: 1 },
    flutter: { label: 'Flutter (0.5 ms, 10 Hz)', delayMs: 0.5, dopplerHz: 10 },
};

/**
 * One path's fading gain: white complex noise at `rate`, through a Gaussian
 * FIR whose response is a Gaussian spectrum of standard deviation `sigmaHz`,
 * normalised so the gain's mean power is 1.
 */
export class FadingTap {
    constructor(rate, sigmaHz, rand) {
        this.rand = rand;
        // In time the Gaussian has σt = 1/(2π σf); taken out to ±4σt.
        const st = 1 / (2 * Math.PI * Math.max(1e-3, sigmaHz));
        const half = Math.max(1, Math.ceil(4 * st * rate));
        const n = 2 * half + 1;
        this.h = new Float64Array(n);
        let e = 0;
        for (let i = 0; i < n; i++) {
            const t = (i - half) / rate;
            this.h[i] = Math.exp(-(t * t) / (2 * st * st));
            e += this.h[i] * this.h[i];
        }
        // Unit power out of unit-power complex noise (each part of variance ½).
        const g = 1 / Math.sqrt(e);
        for (let i = 0; i < n; i++) this.h[i] *= g;
        this.re = new Float64Array(n);
        this.im = new Float64Array(n);
        this.pos = 0;
        // Fill the line so the gain starts at its working power, not at zero.
        for (let i = 0; i < n; i++) this.next();
    }

    next() {
        const { h, re, im } = this;
        const n = h.length;
        re[this.pos] = this.rand() * Math.SQRT1_2;
        im[this.pos] = this.rand() * Math.SQRT1_2;
        this.pos = (this.pos + 1) % n;
        let gr = 0;
        let gi = 0;
        for (let k = 0; k < n; k++) {
            const j = (this.pos + k) % n;
            gr += h[k] * re[j];
            gi += h[k] * im[j];
        }
        return [gr, gi];
    }
}

export const HfChannelBlock = {
    type: 'hf-channel',
    label: 'HF channel',
    category: 'Mixing',
    summary: 'Two fading paths and a delay between them — the Watterson HF channel, at ITU-R F.1487’s Good, Moderate, Poor or Flutter — to try a decoder against the band at its worst.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [{ name: 'out', kind: COMPLEX }],
    params: {
        preset: {
            kind: 'choice', label: 'Conditions', default: 'moderate',
            options: [...Object.entries(WATTERSON).map(([value, c]) => ({ value, label: c.label })), { value: 'custom', label: 'Your own' }],
        },
        delayMs: { kind: 'number', label: 'Delay spread', unit: 'ms', default: 1, min: 0, max: 10, step: 0.1, control: false, showIf: (p) => p.preset === 'custom' },
        dopplerHz: { kind: 'number', label: 'Doppler spread', unit: 'Hz', default: 0.5, min: 0.01, max: 50, step: 0.01, control: false, showIf: (p) => p.preset === 'custom' },
        offsetHz: { kind: 'number', label: 'Frequency offset', unit: 'Hz', default: 0, min: -1000, max: 1000, step: 0.1, live: true },
        seed: { kind: 'number', label: 'Seed', default: 1, min: 1, max: 2147483647, step: 1, control: false },
    },
    create() {
        let rate = 12000;
        let p = {};
        let key = '';
        let taps = [];
        let line = new Float64Array(2);
        let lineIm = new Float64Array(2);
        let lpos = 0;
        let delay = 0;
        let step = 1;
        let prev = [[1, 0], [1, 0]];
        let cur = [[1, 0], [1, 0]];
        let frac = 0;
        let phase = 0;
        let s = 1;
        const rand = () => {
            // xorshift32 into a Gaussian (Box–Muller, one of the pair).
            const u = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) + 0.5) / 4294967296; };
            return Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
        };
        const build = () => {
            const c = WATTERSON[p.preset] || { delayMs: p.delayMs, dopplerHz: p.dopplerHz };
            s = (p.seed >>> 0) || 1;
            // The gains made at 20× the spread, at least 50 Hz, then interpolated.
            const fRate = Math.max(50, 20 * c.dopplerHz);
            step = fRate / rate;
            taps = [new FadingTap(fRate, c.dopplerHz / 2, rand), new FadingTap(fRate, c.dopplerHz / 2, rand)];
            prev = taps.map((t) => t.next());
            cur = taps.map((t) => t.next());
            frac = 0;
            delay = Math.round((c.delayMs / 1000) * rate);
            line = new Float64Array(delay + 1);
            lineIm = new Float64Array(delay + 1);
            lpos = 0;
        };
        return {
            configure(params, r) {
                p = params;
                rate = r || rate;
                const k = `${params.preset}/${params.delayMs}/${params.dopplerHz}/${params.seed}/${rate}`;
                if (k !== key) { key = k; build(); }
            },
            reset() { key = ''; phase = 0; },
            latency() { return delay / 2; },
            process(ins, outs, n) {
                const { re, im } = ins[0];
                const yr = outs[0].re;
                const yi = outs[0].im;
                const len = line.length;
                const dw = (2 * Math.PI * p.offsetHz) / rate;
                // Two equal paths: each at half the power, so the total is unity on average.
                const a = Math.SQRT1_2;
                for (let k = 0; k < n; k++) {
                    frac += step;
                    if (frac >= 1) { frac -= 1; prev = cur; cur = taps.map((t) => t.next()); }
                    const g1r = (prev[0][0] + (cur[0][0] - prev[0][0]) * frac) * a;
                    const g1i = (prev[0][1] + (cur[0][1] - prev[0][1]) * frac) * a;
                    const g2r = (prev[1][0] + (cur[1][0] - prev[1][0]) * frac) * a;
                    const g2i = (prev[1][1] + (cur[1][1] - prev[1][1]) * frac) * a;
                    line[lpos] = re[k];
                    lineIm[lpos] = im[k];
                    const dpos = (lpos + 1) % len; // the oldest: `delay` samples ago
                    const xr = re[k];
                    const xi = im[k];
                    const dr = line[dpos];
                    const di = lineIm[dpos];
                    lpos = dpos;
                    let or = g1r * xr - g1i * xi + g2r * dr - g2i * di;
                    let oi = g1r * xi + g1i * xr + g2r * di + g2i * dr;
                    if (dw) {
                        const c = Math.cos(phase);
                        const sn = Math.sin(phase);
                        const tr = or * c - oi * sn;
                        oi = or * sn + oi * c;
                        or = tr;
                        phase += dw;
                        if (phase > Math.PI) phase -= 2 * Math.PI; else if (phase < -Math.PI) phase += 2 * Math.PI;
                    }
                    yr[k] = or;
                    yi[k] = oi;
                }
                return n;
            },
        };
    },
};
