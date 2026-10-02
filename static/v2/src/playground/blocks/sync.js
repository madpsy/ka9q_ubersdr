// Synchronisation helpers GNU Radio has and the playground lacked: a
// band-edge frequency lock to pull a PSK signal in before a Costas loop can,
// a correlator that finds a known preamble (and the carrier phase with it),
// a Goertzel tone detector, and adaptive equalisers (CMA and LMS) to undo a
// path's echoes.

import { COMPLEX, CONTROL, MESSAGE, REAL, emitControl } from '../block.js';
import { ComplexFir } from '../../lib/dsp/fir.js';
import { parseSyncWord } from './bits.js';

const sinc = (x) => (Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));

/**
 * The band-edge filters' common shape, GNU Radio's design
 * (fll_band_edge_cc_impl.cc, design_filter): two sincs half a sample apart
 * across `size` taps, normalised by their power. Real, and symmetric.
 */
export function bandEdgeTaps(sps, rolloff, size) {
    const M = Math.round(size / sps);
    const t = new Float32Array(size);
    let power = 0;
    for (let i = 0; i < size; i++) {
        const k = -M + (i * 2) / sps;
        const v = sinc(rolloff * k - 0.5) + sinc(rolloff * k + 0.5);
        t[i] = v;
        power += v * v;
    }
    for (let i = 0; i < size; i++) t[i] /= power;
    return t;
}

/**
 * A frequency-locked loop on the band edges, as GNU Radio's FLL band-edge:
 * the energy in a filter on the signal's upper edge against one on its lower
 * edge says which way it is off, whatever its modulation, and the loop turns
 * an oscillator until they balance. It needs no carrier and no symbol timing,
 * so it pulls in from as far as two symbol rates away, where a Costas loop
 * would never lock; then a Costas loop finishes the job.
 *
 * Each edge filter is the shape spun up (or down) to the edge, `(1 + roll-off)
 * / (2 × samples per symbol)` cycles a sample from zero. Only its output's
 * power is wanted, and |Σ h e^{jωj} x[n−j]| is |Σ h (x e^{−jω·})[n−j]|, so each
 * is the signal shifted by the edge and low-passed by the real shape.
 */
export const FllBandEdgeBlock = {
    type: 'fll-band-edge',
    label: 'FLL band-edge',
    category: 'Digital',
    summary: 'Pulls a PSK signal onto zero from up to two symbol rates off, by balancing its band edges — before a Costas loop, which then locks. Feed it a few samples a symbol: decimate first.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [{ name: 'out', kind: COMPLEX }, { name: 'hz', kind: CONTROL }],
    params: {
        baud: { kind: 'number', label: 'Baud', default: 31.25, min: 1, max: 100000, step: 0.01, control: false },
        rolloff: { kind: 'number', label: 'Roll-off', default: 0.35, min: 0.05, max: 1, step: 0.05, control: false },
        span: { kind: 'number', label: 'Filter span', unit: 'symbols', default: 6, min: 2, max: 20, step: 1, control: false },
        bandwidth: { kind: 'number', label: 'Loop bandwidth', unit: 'rad/sample', default: 0.005, min: 0.0001, max: 0.05, step: 0.0001, live: true },
    },
    create() {
        let rate = 12000;
        let p = {};
        let sps = 4;
        let key = '';
        let warn = '';
        const lower = new ComplexFir();
        const upper = new ComplexFir();
        let edge = 0;
        let phase = 0;
        let freq = 0;
        let edgePhase = 0;
        let limit = 1;
        let reported = 0;
        let avg = 0;
        let avgK = 0.01;
        const one = { re: new Float32Array(1), im: new Float32Array(1) };
        return {
            configure(params, r) {
                p = params;
                rate = r || rate;
                sps = rate / p.baud;
                const k = `${p.baud}/${p.rolloff}/${p.span}/${rate}`;
                if (k !== key) {
                    key = k;
                    // Kept within reason: thousands of taps a sample is a
                    // sign the signal wants decimating first.
                    const size = Math.min(2049, Math.max(9, Math.round(p.span * sps) | 1));
                    warn = sps > 64 ? `${Math.round(sps)} samples a symbol: decimate first, to keep this cheap` : '';
                    const taps = bandEdgeTaps(sps, p.rolloff, size);
                    lower.setTaps(taps);
                    upper.setTaps(taps);
                    lower.reset();
                    upper.reset();
                    edge = (2 * Math.PI * (1 + p.rolloff)) / (2 * sps);
                    // The average over about twenty symbols.
                    avgK = 1 / (20 * sps);
                    limit = (2 * Math.PI * 2) / sps;
                    freq = Math.max(-limit, Math.min(limit, freq));
                }
            },
            reset() { phase = 0; freq = 0; edgePhase = 0; avg = 0; lower.reset(); upper.reset(); },
            read() { return { hz: (-freq * rate) / (2 * Math.PI), why: warn }; },
            process(ins, outs, n) {
                const { re, im } = ins[0];
                const o = outs[0];
                // The loop's gains as GNU Radio sets them: frequency only, β = 4 × bandwidth / samples per symbol.
                const beta = (4 * p.bandwidth) / sps;
                for (let k = 0; k < n; k++) {
                    const c = Math.cos(phase);
                    const s = Math.sin(phase);
                    const yr = re[k] * c - im[k] * s;
                    const yi = re[k] * s + im[k] * c;
                    o.re[k] = yr;
                    o.im[k] = yi;
                    // Shifted down by the upper edge, and up by the lower.
                    const ec = Math.cos(edgePhase);
                    const es = Math.sin(edgePhase);
                    one.re[0] = yr * ec + yi * es; one.im[0] = yi * ec - yr * es;
                    upper.process(one.re, one.im, one.re, one.im, 1);
                    const pu = one.re[0] * one.re[0] + one.im[0] * one.im[0];
                    one.re[0] = yr * ec - yi * es; one.im[0] = yi * ec + yr * es;
                    lower.process(one.re, one.im, one.re, one.im, 1);
                    const pl = one.re[0] * one.re[0] + one.im[0] * one.im[0];
                    edgePhase += edge;
                    if (edgePhase > Math.PI) edgePhase -= 2 * Math.PI;
                    // More above than below: the signal is high, so turn down.
                    // Against the edges' power on average, not at this
                    // instant: the loop's gain is then the same at any level,
                    // and a fade or the silence after a signal is not a ratio
                    // of two tiny numbers that drives it anywhere.
                    const err = pu - pl;
                    avg = avg ? avg + (pu + pl - avg) * avgK : pu + pl;
                    freq -= beta * (avg > 0 ? err / avg : 0);
                    if (freq > limit) freq = limit; else if (freq < -limit) freq = -limit;
                    phase += freq;
                    if (phase > Math.PI) phase -= 2 * Math.PI; else if (phase < -Math.PI) phase += 2 * Math.PI;
                }
                // The signal's own offset from zero, the opposite of the correction.
                const hz = (-freq * rate) / (2 * Math.PI);
                if (outs[1] && hz !== reported) { reported = hz; emitControl(outs[1], hz); }
                return n;
            },
        };
    },
};

/**
 * A known preamble, found: symbols in (one a symbol, as Symbol sync puts
 * out), against a pattern of BPSK symbols, the correlation's magnitude
 * against the power of the symbols it spans — 1 for a perfect match, whatever
 * the carrier's phase. And the phase is what the match measures besides: the
 * angle of the sum is the carrier's phase at the preamble, which settles a
 * PSK receiver's ambiguity (is it upside down?) once and for all. GNU Radio's
 * corr_est does this on samples; here it is on symbols, after timing.
 */
export const CorrelatorBlock = {
    type: 'correlator',
    label: 'Preamble correlator',
    category: 'Digital',
    summary: 'Finds a known run of BPSK symbols in the symbol stream: how well it matches now (1 is perfect), a message each time it is found, and the carrier’s phase there.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [{ name: 'match', kind: REAL }, { name: 'found', kind: MESSAGE }, { name: 'phase', kind: CONTROL }],
    params: {
        pattern: { kind: 'text', label: 'Pattern (bits, or 0x hex)', default: '1111100110101', max: 256 },
        threshold: { kind: 'number', label: 'Found above', default: 0.9, min: 0.1, max: 1, step: 0.01, live: true },
    },
    create() {
        let pat = new Float64Array(0);
        let why = '';
        let ringI = new Float64Array(1);
        let ringQ = new Float64Array(1);
        let pos = 0;
        let seen = 0;
        let p = {};
        let found = 0;
        let above = false;
        let best = null;
        let last = null;
        return {
            configure(params) {
                p = params;
                const bits = parseSyncWord(params.pattern);
                why = bits && bits.length ? '' : 'The pattern wants 0s and 1s, or 0x and hex digits';
                const next = Float64Array.from(bits || [], (b) => (b ? 1 : -1));
                if (next.length !== pat.length || next.some((v, i) => v !== pat[i])) {
                    pat = next;
                    ringI = new Float64Array(Math.max(1, pat.length));
                    ringQ = new Float64Array(Math.max(1, pat.length));
                    pos = 0;
                    seen = 0;
                }
            },
            reset() { ringI.fill(0); ringQ.fill(0); pos = 0; seen = 0; above = false; },
            read() { return { found, last, why }; },
            process(ins, outs, n) {
                const { re, im } = ins[0];
                const L = pat.length;
                const y = outs[0].re;
                for (let k = 0; k < n; k++) {
                    ringI[pos] = re[k];
                    ringQ[pos] = im[k];
                    pos = (pos + 1) % Math.max(1, L);
                    seen++;
                    if (!L || seen < L) { y[k] = 0; continue; }
                    // The oldest symbol in the ring meets the pattern's first.
                    let sr = 0;
                    let si = 0;
                    let e = 0;
                    for (let j = 0; j < L; j++) {
                        const r = (pos + j) % L;
                        sr += pat[j] * ringI[r];
                        si += pat[j] * ringQ[r];
                        e += ringI[r] * ringI[r] + ringQ[r] * ringQ[r];
                    }
                    const m = e > 0 ? Math.hypot(sr, si) / Math.sqrt(L * e) : 0;
                    y[k] = m;
                    // Reported at the peak of each pass above the threshold.
                    if (m >= p.threshold) {
                        if (!above || m > best.match) best = { match: m, phase: Math.atan2(si, sr) };
                        above = true;
                    } else if (above) {
                        above = false;
                        found++;
                        last = { match: best.match, phaseDeg: (best.phase * 180) / Math.PI };
                        outs[1].list.push({ type: 'text', text: `Preamble found (${(best.match * 100).toFixed(0)}% match, phase ${last.phaseDeg.toFixed(0)}°)\n` });
                        if (outs[2]) emitControl(outs[2], last.phaseDeg);
                    }
                }
                return n;
            },
        };
    },
};

/**
 * One frequency's strength, by Goertzel's algorithm: a single bin of a DFT,
 * a window at a time, for a few multiplies a sample — how DTMF decoders and
 * tone squelches listen. The window sets the bandwidth, about 1/window Hz
 * wide. Out: the tone's amplitude (as the tone's own peak, so a full-scale
 * tone reads 1) each window, held between, and in dB as a control.
 */
export const GoertzelBlock = {
    type: 'goertzel',
    label: 'Tone detector (Goertzel)',
    category: 'Digital',
    summary: 'How strong one frequency is, a window at a time — a single DFT bin, as DTMF decoders and tone squelches listen. The window sets how narrow.',
    inputs: [{ name: 'in', kind: REAL }],
    outputs: [{ name: 'level', kind: REAL }, { name: 'db', kind: CONTROL }],
    params: {
        frequencyHz: { kind: 'number', label: 'Frequency', unit: 'Hz', default: 1000, min: 1, max: 96000, step: 1, live: true },
        windowMs: { kind: 'number', label: 'Window', unit: 'ms', default: 20, min: 1, max: 2000, step: 1, live: true },
    },
    create() {
        let rate = 12000;
        let p = {};
        let s1 = 0;
        let s2 = 0;
        let got = 0;
        let level = 0;
        let coeff = 0;
        let N = 1;
        return {
            configure(params, r) {
                p = params;
                rate = r || rate;
                N = Math.max(4, Math.round((p.windowMs / 1000) * rate));
                coeff = 2 * Math.cos((2 * Math.PI * p.frequencyHz) / rate);
            },
            reset() { s1 = 0; s2 = 0; got = 0; level = 0; },
            read() { return { level, db: 20 * Math.log10(Math.max(level, 1e-10)) }; },
            process(ins, outs, n) {
                const x = ins[0].re;
                const y = outs[0].re;
                for (let k = 0; k < n; k++) {
                    const s0 = x[k] + coeff * s1 - s2;
                    s2 = s1;
                    s1 = s0;
                    if (++got >= N) {
                        const pow = s1 * s1 + s2 * s2 - coeff * s1 * s2;
                        level = (2 * Math.sqrt(Math.max(0, pow))) / N;
                        s1 = 0; s2 = 0; got = 0;
                        if (outs[1]) emitControl(outs[1], 20 * Math.log10(Math.max(level, 1e-10)));
                    }
                    y[k] = level;
                }
                return n;
            },
        };
    },
};

/** The nearest point of M-PSK (M = 2, 4 or 8) to (r, i), at unit amplitude; QPSK's points on the diagonals, as the slicer has them. */
function nearestPsk(M, r, i) {
    if (M === 2) return [r >= 0 ? 1 : -1, 0];
    if (M === 4) return [r >= 0 ? Math.SQRT1_2 : -Math.SQRT1_2, i >= 0 ? Math.SQRT1_2 : -Math.SQRT1_2];
    const a = Math.round((Math.atan2(i, r) * M) / (2 * Math.PI)) * ((2 * Math.PI) / M);
    return [Math.cos(a), Math.sin(a)];
}

/**
 * An adaptive equaliser, one symbol a sample (after Symbol sync): a complex
 * FIR whose taps learn to undo what the path did — an echo a symbol or two
 * late, a lopsided passband — as GNU Radio's CMA and LMS-DD equalisers do.
 *
 *   CMA      Constant modulus: PSK's symbols all have the same size, so the
 *            taps are nudged to make every output's size 1. Needs no
 *            decisions, so it starts from anywhere; it leaves the carrier's
 *            phase alone, for a Costas loop after it.
 *   LMS-DD   Decision-directed: each output is pulled towards the nearest
 *            point of the constellation. Corrects the phase too, but only
 *            once the eye is open enough for most decisions to be right — so
 *            start with CMA and switch, or feed it a signal already close.
 *
 * The input is kept at unit power by a slow AGC of its own, so the step size
 * means the same at any level.
 */
export const EqualiserBlock = {
    type: 'equaliser',
    label: 'Adaptive equaliser',
    category: 'Digital',
    summary: 'Undoes echoes and a tilted passband on PSK symbols, its taps learning as it goes — constant modulus (CMA) to start from nothing, or decision-directed (LMS) to finish. One symbol a sample: after Symbol sync.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [{ name: 'out', kind: COMPLEX }],
    params: {
        method: { kind: 'choice', label: 'Method', default: 'cma', options: [{ value: 'cma', label: 'Constant modulus (CMA)' }, { value: 'lms', label: 'Decision-directed (LMS)' }] },
        constellation: { kind: 'choice', label: 'Constellation', default: 4, options: [{ value: 2, label: 'BPSK' }, { value: 4, label: 'QPSK' }, { value: 8, label: '8PSK' }], showIf: (p) => p.method === 'lms' },
        taps: { kind: 'number', label: 'Taps', default: 7, min: 1, max: 63, step: 2, control: false },
        step: { kind: 'number', label: 'Step size', default: 0.005, min: 0.0001, max: 0.1, step: 0.0001, live: true },
        freeze: { kind: 'bool', label: 'Freeze the taps', default: false, live: true },
    },
    create() {
        let p = {};
        let N = 0;
        let wr = new Float64Array(1);
        let wi = new Float64Array(1);
        let xr = new Float64Array(2);
        let xi = new Float64Array(2);
        let pos = 0;
        let power = 0;
        const init = (n) => {
            N = n;
            wr = new Float64Array(N);
            wi = new Float64Array(N);
            wr[N >> 1] = 1;
            // Doubled, so the newest N are always one straight run.
            xr = new Float64Array(2 * N);
            xi = new Float64Array(2 * N);
            pos = 0;
        };
        return {
            configure(params) {
                p = params;
                const n = Math.max(1, params.taps | 1);
                if (n !== N) init(n);
            },
            reset() { init(N || 7); power = 0; },
            read() { return { taps: Array.from(wr, (r, k) => Math.hypot(r, wi[k])) }; },
            process(ins, outs, n) {
                const { re, im } = ins[0];
                const o = outs[0];
                const mu = p.step;
                const M = +p.constellation || 4;
                for (let k = 0; k < n; k++) {
                    const pin = re[k] * re[k] + im[k] * im[k];
                    power = power ? power + 0.01 * (pin - power) : pin;
                    const g = power > 0 ? 1 / Math.sqrt(power) : 0;
                    pos = pos === 0 ? N - 1 : pos - 1;
                    xr[pos] = xr[pos + N] = re[k] * g;
                    xi[pos] = xi[pos + N] = im[k] * g;
                    // y = Σ w_j x[n−j]: the newest sample at pos, older after it.
                    let yr = 0;
                    let yi = 0;
                    for (let j = 0; j < N; j++) {
                        const ar = xr[pos + j];
                        const ai = xi[pos + j];
                        yr += wr[j] * ar - wi[j] * ai;
                        yi += wr[j] * ai + wi[j] * ar;
                    }
                    o.re[k] = yr;
                    o.im[k] = yi;
                    if (p.freeze) continue;
                    let er;
                    let ei;
                    if (p.method === 'lms') {
                        const [dr, di] = nearestPsk(M, yr, yi);
                        er = yr - dr;
                        ei = yi - di;
                    } else {
                        const m = yr * yr + yi * yi - 1;
                        er = yr * m;
                        ei = yi * m;
                    }
                    // w_j −= μ e conj(x[n−j])
                    for (let j = 0; j < N; j++) {
                        const ar = xr[pos + j];
                        const ai = xi[pos + j];
                        wr[j] -= mu * (er * ar + ei * ai);
                        wi[j] -= mu * (ei * ar - er * ai);
                    }
                }
                return n;
            },
        };
    },
};
