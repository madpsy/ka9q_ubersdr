// Small stream tools, as GNU Radio has them (gr-blocks): a complex signal's
// phase, a moving average, integrate and dump, a derivative, sample and hold,
// keeping one sample in N, a switch between two signals, and noise.
//
// Each is a few lines, and each is the kind of thing a graph needs between the
// blocks that do the real work: the phase of a carrier to watch it drift, an
// average to steady a reading, integrate-and-dump as a symbol's matched filter,
// a switch so a control can pick which signal goes on.

import { COMPLEX, REAL } from '../block.js';

const R_IN = [{ name: 'in', kind: REAL }];
const R_OUT = [{ name: 'out', kind: REAL }];
const int = (label, def, min, max, extra = {}) => ({ kind: 'number', label, default: def, min, max, step: 1, ...extra });

/**
 * The angle of a complex signal (gr-blocks complex_to_arg), optionally
 * unwrapped — carried on past ±π, so a carrier slowly off frequency is a ramp
 * rather than a sawtooth — in radians, degrees or cycles.
 */
export const PhaseBlock = {
    type: 'phase',
    label: 'Phase',
    category: 'Math',
    summary: 'The angle of a complex signal, wrapped or unwrapped, in radians, degrees or cycles — a carrier’s drift, a PSK signal’s phase.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: R_OUT,
    params: {
        unwrap: { kind: 'bool', label: 'Unwrap', default: true, live: true },
        units: {
            kind: 'choice', label: 'Units', default: 'rad',
            options: [{ value: 'rad', label: 'Radians' }, { value: 'deg', label: 'Degrees' }, { value: 'cyc', label: 'Cycles' }],
        },
    },
    create() {
        let p = {};
        let prev = null;
        let turns = 0;
        return {
            configure(params) { p = params; },
            reset() { prev = null; turns = 0; },
            process(ins, outs, n) {
                const { re, im } = ins[0];
                const y = outs[0].re;
                const scale = p.units === 'deg' ? 180 / Math.PI : p.units === 'cyc' ? 1 / (2 * Math.PI) : 1;
                for (let k = 0; k < n; k++) {
                    const a = Math.atan2(im[k], re[k]);
                    if (p.unwrap) {
                        if (prev !== null) {
                            const d = a - prev;
                            if (d > Math.PI) turns -= 2 * Math.PI;
                            else if (d < -Math.PI) turns += 2 * Math.PI;
                        }
                        prev = a;
                        y[k] = (a + turns) * scale;
                    } else {
                        prev = null;
                        turns = 0;
                        y[k] = a * scale;
                    }
                }
                return n;
            },
        };
    },
};

/**
 * The mean (or sum) of the last N samples (gr-blocks moving_average): a box
 * filter, whose delay is half its length.
 */
export const MovingAverageBlock = {
    type: 'moving-average',
    label: 'Moving average',
    category: 'Math',
    summary: 'The mean, or the sum, of the last N samples — a reading steadied, a box filter.',
    inputs: R_IN,
    outputs: R_OUT,
    params: {
        length: int('Length', 100, 1, 1000000, { unit: 'samples' }),
        sum: { kind: 'bool', label: 'Sum rather than mean', default: false, live: true },
    },
    create() {
        let p = {};
        let buf = new Float64Array(1);
        let pos = 0;
        let filled = 0;
        let acc = 0;
        let since = 0;
        return {
            configure(params) {
                p = params;
                const n = Math.max(1, Math.round(params.length));
                if (n !== buf.length) { buf = new Float64Array(n); pos = 0; filled = 0; acc = 0; }
            },
            reset() { buf.fill(0); pos = 0; filled = 0; acc = 0; },
            latency() { return (buf.length - 1) / 2; },
            process(ins, outs, n) {
                const x = ins[0].re;
                const y = outs[0].re;
                const len = buf.length;
                for (let k = 0; k < n; k++) {
                    acc += x[k] - buf[pos];
                    buf[pos] = x[k];
                    pos = pos + 1 === len ? 0 : pos + 1;
                    if (filled < len) filled++;
                    // A running sum drifts with rounding; it is added up afresh
                    // once a window, which costs nothing worth counting.
                    if (++since >= len) { since = 0; acc = 0; for (let i = 0; i < len; i++) acc += buf[i]; }
                    y[k] = p.sum ? acc : acc / filled;
                }
                return n;
            },
        };
    },
};

/**
 * Integrate and dump (gr-blocks integrate): N samples summed (or averaged) to
 * one, so the rate comes down by N. With N a symbol's length, a rectangular
 * symbol's matched filter.
 */
export const IntegrateDumpBlock = {
    type: 'integrate-dump',
    label: 'Integrate & dump',
    category: 'Math',
    summary: 'Sums (or averages) every N samples to one — the rate down by N; a rectangular symbol’s matched filter.',
    inputs: R_IN,
    outputs: R_OUT,
    rate: (inRate, p) => inRate / Math.max(1, Math.round(p.length)),
    maxOut: (n, p) => Math.ceil(n / Math.max(1, Math.round(p.length))) + 1,
    params: {
        length: int('N', 10, 1, 100000, { control: false }),
        mean: { kind: 'bool', label: 'Average rather than sum', default: false, live: true },
    },
    create() {
        let p = {};
        let acc = 0;
        let got = 0;
        return {
            configure(params) { p = params; },
            reset() { acc = 0; got = 0; },
            process(ins, outs, n) {
                const x = ins[0].re;
                const y = outs[0].re;
                const len = Math.max(1, Math.round(p.length));
                let m = 0;
                for (let k = 0; k < n; k++) {
                    acc += x[k];
                    if (++got >= len) {
                        y[m++] = p.mean ? acc / len : acc;
                        acc = 0;
                        got = 0;
                    }
                }
                return m;
            },
        };
    },
};

/** The change from one sample to the next — per sample, or per second. */
export const DifferentiatorBlock = {
    type: 'differentiate',
    label: 'Differentiator',
    category: 'Math',
    summary: 'The change from each sample to the next, per sample or per second — a phase to a frequency, a level to its rate.',
    inputs: R_IN,
    outputs: R_OUT,
    params: {
        scaleToSeconds: { kind: 'bool', label: 'Per second', default: false, live: true },
    },
    create() {
        let p = {};
        let rate = 1;
        let prev = null;
        return {
            configure(params, r) { p = params; rate = r || rate; },
            reset() { prev = null; },
            latency() { return 0.5; },
            process(ins, outs, n) {
                const x = ins[0].re;
                const y = outs[0].re;
                const scale = p.scaleToSeconds ? rate : 1;
                for (let k = 0; k < n; k++) {
                    y[k] = prev === null ? 0 : (x[k] - prev) * scale;
                    prev = x[k];
                }
                return n;
            },
        };
    },
};

/**
 * Sample and hold (gr-blocks sample_and_hold): the input passed while the
 * control signal is high and held while it is low — or, on edge, taken once
 * at each rising edge of the control and held until the next.
 */
export const SampleHoldBlock = {
    type: 'sample-hold',
    label: 'Sample & hold',
    category: 'Math',
    summary: 'Follows the input while the gate is high and holds it while low — or takes one sample at each rising edge.',
    inputs: [{ name: 'in', kind: REAL }, { name: 'gate', kind: REAL }],
    outputs: R_OUT,
    params: {
        mode: {
            kind: 'choice', label: 'Mode', default: 'track',
            options: [{ value: 'track', label: 'Track while high' }, { value: 'edge', label: 'Sample on rising edge' }],
        },
    },
    create() {
        let p = {};
        let held = 0;
        let prevGate = 0;
        return {
            configure(params) { p = params; },
            reset() { held = 0; prevGate = 0; },
            process(ins, outs, n) {
                const x = ins[0].re;
                const g = ins[1].re;
                const y = outs[0].re;
                for (let k = 0; k < n; k++) {
                    const high = g[k] >= 0.5;
                    if (p.mode === 'edge' ? high && prevGate < 0.5 : high) held = x[k];
                    prevGate = g[k];
                    y[k] = held;
                }
                return n;
            },
        };
    },
};

/**
 * One sample in N kept, the rest dropped (gr-blocks keep_one_in_n): the rate
 * down by N with no filter, so whatever is above the new Nyquist folds down —
 * for a signal already slow enough, or a symbol stream already timed.
 */
export const KeepOneInNBlock = {
    type: 'keep-one-in-n',
    label: 'Keep 1 in N',
    category: 'Math',
    summary: 'Keeps every Nth sample and drops the rest — no filter, so only for a signal already slow enough.',
    inputs: R_IN,
    outputs: R_OUT,
    rate: (inRate, p) => inRate / Math.max(1, Math.round(p.n)),
    maxOut: (n, p) => Math.ceil(n / Math.max(1, Math.round(p.n))) + 1,
    params: {
        n: int('N', 4, 1, 100000, { control: false }),
        offset: int('Offset', 0, 0, 99999),
    },
    create() {
        let p = {};
        let count = 0;
        return {
            configure(params) { p = params; },
            reset() { count = 0; },
            process(ins, outs, n) {
                const x = ins[0].re;
                const y = outs[0].re;
                const every = Math.max(1, Math.round(p.n));
                const off = Math.round(p.offset) % every;
                let m = 0;
                for (let k = 0; k < n; k++) {
                    if (count % every === off) y[m++] = x[k];
                    count++;
                }
                return m;
            },
        };
    },
};

/**
 * One of two signals, by a switch (gr-blocks selector): `useB` is a setting,
 * so a control — a Toggle, a Threshold's state, a Clock's window — can choose.
 */
export const SelectorBlock = {
    type: 'selector',
    label: 'Switch',
    category: 'Math',
    summary: 'Passes A or B, as its switch says — and the switch can be a control, so another block can choose.',
    inputs: [{ name: 'a', kind: REAL }, { name: 'b', kind: REAL }],
    outputs: R_OUT,
    params: {
        useB: { kind: 'bool', label: 'Pass B', default: false, live: true },
    },
    create() {
        let p = {};
        return {
            configure(params) { p = params; },
            reset() {},
            process(ins, outs, n) {
                const x = (p.useB ? ins[1] : ins[0]).re;
                outs[0].re.set(x.subarray(0, n));
                return n;
            },
        };
    },
};

/**
 * Noise (gr-analog noise_source): Gaussian or uniform, real and complex at
 * once — and, with a signal wired in, added to it: a complex one into `in`
 * comes out of `iq` with noise, a real one (audio, a detector's output) into
 * `audio` comes out of `out` with noise, so the block can go between any two.
 *
 * On its own it is a source at the stream's rate: `out` real noise, `iq`
 * complex noise with independent I and Q, `amplitude` the RMS of each. Wired
 * to the IQ stream (or any complex signal), `iq` is that signal with the noise
 * added — a real signal made worse in a controlled way, which is how a decoder
 * is tested against conditions the band is not offering today. The level is
 * then either the RMS, or an SNR below the signal's own power, measured as it
 * goes (over about a second), so "10 dB SNR" stays 10 dB as the signal fades.
 */
export const NoiseSourceBlock = {
    type: 'noise',
    label: 'Noise source',
    category: 'Sources',
    summary: 'Gaussian or uniform noise, real and complex — on its own, or added to a signal wired in, at an RMS or an SNR below it.',
    inputs: [{ name: 'in', kind: COMPLEX, optional: true }, { name: 'audio', kind: REAL, optional: true }],
    outputs: [{ name: 'out', kind: REAL }, { name: 'iq', kind: COMPLEX }],
    params: {
        distribution: {
            kind: 'choice', label: 'Kind', default: 'gaussian',
            options: [{ value: 'gaussian', label: 'Gaussian' }, { value: 'uniform', label: 'Uniform' }],
        },
        level: {
            kind: 'choice', label: 'Level as', default: 'rms',
            options: [{ value: 'rms', label: 'RMS' }, { value: 'snr', label: 'SNR below the input' }],
        },
        amplitude: { kind: 'number', label: 'RMS', default: 0.1, min: 0, max: 10, step: 0.001, live: true, showIf: (p) => p.level !== 'snr' },
        snrDb: { kind: 'number', label: 'SNR', unit: 'dB', default: 10, min: -40, max: 80, step: 0.5, live: true, showIf: (p) => p.level === 'snr' },
        seed: int('Seed', 1, 1, 2147483647, { control: false }),
    },
    create() {
        let p = {};
        let rate = 12000;
        let s = 1;
        let spare = null;
        // Each input's power, smoothed over about a second, for the SNR level.
        let power = null;
        let powerA = null;
        // xorshift32: fast, and the same noise for the same seed every run.
        const u = () => {
            s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
            return ((s >>> 0) + 0.5) / 4294967296;
        };
        const gauss = () => {
            if (spare !== null) { const v = spare; spare = null; return v; }
            const r = Math.sqrt(-2 * Math.log(u()));
            const th = 2 * Math.PI * u();
            spare = r * Math.sin(th);
            return r * Math.cos(th);
        };
        // Uniform on ±√3: unit RMS like the Gaussian.
        const uni = () => (u() * 2 - 1) * Math.sqrt(3);
        let seeded = null;
        return {
            configure(params, r) {
                p = params;
                rate = r || rate;
                if (params.seed !== seeded) { seeded = params.seed; s = (params.seed >>> 0) || 1; spare = null; }
            },
            reset() { s = (p.seed >>> 0) || 1; spare = null; power = null; powerA = null; },
            read() {
                const db = (v) => (v ? 10 * Math.log10(v) : null);
                return { inputDb: db(power), audioDb: db(powerA) };
            },
            process(ins, outs, n) {
                const draw = p.distribution === 'uniform' ? uni : gauss;
                const x = ins && ins[0] && ins[0].re ? ins[0] : null;
                const xa = ins && ins[1] && ins[1].re ? ins[1].re : null;
                const w = Math.min(1, n / rate);
                const snr = 10 ** (p.snrDb / 10);
                // Each input's mean power over this packet, folded into a
                // one-second average, and the noise that puts it at the SNR.
                let a = p.amplitude;
                if (x) {
                    let sum = 0;
                    for (let k = 0; k < n; k++) sum += x.re[k] * x.re[k] + x.im[k] * x.im[k];
                    const now = n ? sum / n : 0;
                    power = power === null ? now : power + w * (now - power);
                    if (p.level === 'snr') a = Math.sqrt(Math.max(0, power) / snr);
                }
                let aa = p.amplitude;
                if (xa) {
                    let sum = 0;
                    for (let k = 0; k < n; k++) sum += xa[k] * xa[k];
                    const now = n ? sum / n : 0;
                    powerA = powerA === null ? now : powerA + w * (now - powerA);
                    if (p.level === 'snr') aa = Math.sqrt(Math.max(0, powerA) / snr);
                }
                const y = outs[0] && outs[0].re;
                const iq = outs[1];
                const c = a / Math.SQRT2;
                for (let k = 0; k < n; k++) {
                    if (y) y[k] = (xa ? xa[k] : 0) + aa * draw();
                    if (iq && iq.re) {
                        iq.re[k] = (x ? x.re[k] : 0) + c * draw();
                        iq.im[k] = (x ? x.im[k] : 0) + c * draw();
                    }
                }
                return n;
            },
        };
    },
};
