// Pulse-shaping filters and the Hilbert transform, designed as GNU Radio's
// firdes designs them (gr-filter/lib/firdes.cc): root-raised-cosine and
// Gaussian matched filters, a rectangular one, taps of your own, and a Hilbert
// transformer that turns a real signal into its analytic, complex one.
//
// A matched filter is the receiving half of a pulse shape: filtering a symbol
// stream with the shape it was sent with maximises its SNR at the symbol's
// centre, and for a root-raised-cosine pair leaves no intersymbol interference
// there. They are FIRs, linear-phase (the custom one aside), so each delays
// by half its length and says so as its latency.

import { COMPLEX, REAL } from '../block.js';
import { ComplexFir, RealFir } from '../../lib/dsp/fir.js';

/** firdes::root_raised_cosine: `ntaps` (made odd) taps, unity DC gain × `gain`. */
export function rootRaisedCosine(gain, fs, symbolRate, alpha, ntaps) {
    const n = ntaps | 1;
    const spb = fs / symbolRate;
    const taps = new Float64Array(n);
    let scale = 0;
    const half = Math.floor(n / 2);
    for (let i = 0; i < n; i++) {
        const x = i - half;
        const x1 = (Math.PI * x) / spb;
        let x2 = (4 * alpha * x) / spb;
        let x3 = x2 * x2 - 1;
        let num;
        let den;
        if (Math.abs(x3) >= 0.000001) {
            num = i !== half
                ? Math.cos((1 + alpha) * x1) + Math.sin((1 - alpha) * x1) / ((4 * alpha * x) / spb)
                : Math.cos((1 + alpha) * x1) + ((1 - alpha) * Math.PI) / (4 * alpha);
            den = x3 * Math.PI;
        } else {
            if (alpha === 1) { taps[i] = -1; scale += taps[i]; continue; }
            x3 = (1 - alpha) * x1;
            x2 = (1 + alpha) * x1;
            num = Math.sin(x2) * (1 + alpha) * Math.PI
                - (Math.cos(x3) * ((1 - alpha) * Math.PI * spb)) / (4 * alpha * x)
                + (Math.sin(x3) * spb * spb) / (4 * alpha * x * x);
            den = (-32 * Math.PI * alpha * alpha * x) / spb;
        }
        taps[i] = (4 * alpha * num) / den;
        scale += taps[i];
    }
    for (let i = 0; i < n; i++) taps[i] = (taps[i] * gain) / scale;
    return taps;
}

/**
 * firdes::gaussian: `ntaps` taps for `spb` samples a symbol and bandwidth-time
 * BT. Centred on the middle tap, where firdes centres it half a sample later
 * (its t0 starts at −ntaps/2 and is stepped before use) — for an odd length
 * that puts the peak between two taps, and the filter's delay half a sample
 * off the (n − 1)/2 it reports as latency.
 */
export function gaussianTaps(gain, spb, bt, ntaps) {
    const taps = new Float64Array(ntaps);
    let scale = 0;
    const dt = 1 / spb;
    const s = 1 / (Math.sqrt(Math.log(2)) / (2 * Math.PI * bt));
    const mid = (ntaps - 1) / 2;
    for (let i = 0; i < ntaps; i++) {
        const t0 = i - mid;
        const ts = s * dt * t0;
        taps[i] = Math.exp(-0.5 * ts * ts);
        scale += taps[i];
    }
    for (let i = 0; i < ntaps; i++) taps[i] = (taps[i] / scale) * gain;
    return taps;
}

/** A Hamming window of n points, firdes's default for the Hilbert transformer. */
function hamming(n) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
    return w;
}

/** firdes::hilbert: an odd number of antisymmetric taps, windowed, unity gain in band. */
export function hilbertTaps(ntaps) {
    const n = ntaps | 1;
    const taps = new Float64Array(n);
    const w = hamming(n);
    const h = (n - 1) / 2;
    let gain = 0;
    for (let i = 1; i <= h; i++) {
        if (i & 1) {
            const x = 1 / i;
            taps[h + i] = x * w[h + i];
            taps[h - i] = -x * w[h - i];
            gain = taps[h + i] - gain;
        }
    }
    gain = 2 * Math.abs(gain);
    for (let i = 0; i < n; i++) taps[i] /= gain;
    return taps;
}

/** Taps typed as numbers separated by commas, spaces or new lines; null if none. */
export function parseTaps(text) {
    const out = [];
    for (const t of String(text || '').split(/[\s,;]+/)) {
        if (t === '') continue;
        const v = Number(t);
        if (!Number.isFinite(v)) return null;
        out.push(v);
    }
    return out.length && out.length <= 4095 ? Float64Array.from(out) : null;
}

const SHAPES = [
    { value: 'rrc', label: 'Root-raised-cosine' },
    { value: 'gaussian', label: 'Gaussian' },
    { value: 'rect', label: 'Rectangular (integrate)' },
    { value: 'custom', label: 'Taps of your own' },
];

/** The taps a matched filter's settings describe at rate `fs`. */
export function matchedTaps(p, fs) {
    const spb = Math.max(1, fs / Math.max(0.001, p.symbolRate));
    const span = Math.max(1, Math.round(p.span));
    const len = Math.min(4095, Math.round(span * spb) | 1);
    switch (p.shape) {
        case 'gaussian': return gaussianTaps(1, spb, p.bt, len);
        case 'rect': {
            const n = Math.max(1, Math.round(spb));
            return new Float64Array(n).fill(1 / n);
        }
        case 'custom': return parseTaps(p.taps) || Float64Array.of(1);
        default: return rootRaisedCosine(1, fs, p.symbolRate, Math.max(0.01, Math.min(1, p.rolloff)), len);
    }
}

const MATCHED_PARAMS = {
    shape: { kind: 'choice', label: 'Shape', default: 'rrc', options: SHAPES },
    symbolRate: { kind: 'number', label: 'Symbol rate', unit: 'Bd', default: 31.25, min: 0.1, max: 100000, step: 0.01, control: false, showIf: (p) => p.shape !== 'custom' },
    rolloff: { kind: 'number', label: 'Roll-off', default: 0.35, min: 0.01, max: 1, step: 0.01, control: false, showIf: (p) => p.shape === 'rrc' },
    bt: { kind: 'number', label: 'BT', default: 0.5, min: 0.1, max: 2, step: 0.05, control: false, showIf: (p) => p.shape === 'gaussian' },
    span: { kind: 'number', label: 'Span', unit: 'symbols', default: 8, min: 1, max: 64, step: 1, control: false, showIf: (p) => p.shape === 'rrc' || p.shape === 'gaussian' },
    taps: { kind: 'text', label: 'Taps', default: '1', max: 40000, multiline: true, showIf: (p) => p.shape === 'custom' },
};

// The FIRs here run the delay line oldest-first, so a filter's taps go in
// reversed — which only matters for the ones that are not symmetric (a
// Hilbert transformer, taps of your own).
const reversed = (taps) => Float32Array.from(taps).reverse();

function matched(complex) {
    return () => {
        const fir = complex ? new ComplexFir() : new RealFir();
        let key = '';
        return {
            configure(p, r) {
                const k = `${p.shape}/${p.symbolRate}/${p.rolloff}/${p.bt}/${p.span}/${p.shape === 'custom' ? p.taps : ''}/${r}`;
                if (k !== key) { key = k; fir.setTaps(reversed(matchedTaps(p, r))); }
            },
            reset() { fir.reset(); },
            read() { return { taps: fir.n }; },
            latency() { return Math.max(0, (fir.n - 1) / 2); },
            process(ins, outs, n) {
                if (complex) fir.process(ins[0].re, ins[0].im, outs[0].re, outs[0].im, n);
                else fir.process(ins[0].re, outs[0].re, n);
                return n;
            },
        };
    };
}

export const MatchedFilterBlock = {
    type: 'matched-filter',
    label: 'Matched filter (complex)',
    category: 'Filters',
    summary: 'Root-raised-cosine, Gaussian, rectangular or your own taps — a symbol stream’s receive filter, for the best SNR at each symbol.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [{ name: 'out', kind: COMPLEX }],
    params: MATCHED_PARAMS,
    create: matched(true),
};

export const MatchedFilterAudioBlock = {
    type: 'matched-filter-audio',
    label: 'Matched filter (audio)',
    category: 'Filters',
    summary: 'The same shapes on a real signal — a demodulated symbol stream, an FSK detector’s output.',
    inputs: [{ name: 'in', kind: REAL }],
    outputs: [{ name: 'out', kind: REAL }],
    params: MATCHED_PARAMS,
    create: matched(false),
};

/**
 * A Hilbert transformer (gr-filter hilbert_fc): a real signal in, its analytic
 * signal out — the input, delayed to match, as I, and its 90° shifted copy as
 * Q — so positive frequencies stay and the negative mirror cancels. Audio made
 * IQ: to put it through the complex blocks, or to read its envelope and phase.
 */
export const HilbertBlock = {
    type: 'hilbert',
    label: 'Hilbert transform',
    category: 'Filters',
    summary: 'A real signal to its analytic (complex) one: the input as I, shifted 90° as Q — audio into the complex blocks.',
    inputs: [{ name: 'in', kind: REAL }],
    outputs: [{ name: 'out', kind: COMPLEX }],
    params: {
        taps: { kind: 'number', label: 'Taps', default: 65, min: 7, max: 1023, step: 2, control: false },
    },
    create() {
        const fir = new RealFir();
        let n = 0;
        let line = new Float64Array(1);
        let pos = 0;
        return {
            configure(p) {
                const want = Math.max(7, Math.round(p.taps)) | 1;
                if (want !== n) {
                    n = want;
                    fir.setTaps(reversed(hilbertTaps(n)));
                    line = new Float64Array((n - 1) / 2 + 1);
                    pos = 0;
                }
            },
            reset() { fir.reset(); line.fill(0); pos = 0; },
            latency() { return (n - 1) / 2; },
            process(ins, outs, m) {
                const x = ins[0].re;
                fir.process(x, outs[0].im, m);
                // I is the input delayed by the transformer's half-length.
                const re = outs[0].re;
                const len = line.length;
                for (let k = 0; k < m; k++) {
                    line[pos] = x[k];
                    pos = pos + 1 === len ? 0 : pos + 1;
                    re[k] = line[pos];
                }
                return m;
            },
        };
    },
};
