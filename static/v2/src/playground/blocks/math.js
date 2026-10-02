// Arithmetic on signals, and moving between real and complex.

import { BITS, COMPLEX, CONTROL, REAL, emitControl } from '../block.js';

const stateless = (process) => () => ({ configure() {}, reset() {}, process });

export const GainBlock = {
    type: 'gain',
    label: 'Gain',
    category: 'Math',
    summary: 'Multiplies by a constant.',
    inputs: [{ name: 'in', kind: REAL }],
    outputs: [{ name: 'out', kind: REAL }],
    params: {
        gain: { kind: 'number', label: 'Gain', unit: '×', default: 1, min: 0, max: 1000, step: 0.05, live: true },
    },
    create() {
        let g = 1;
        return {
            configure(p) { g = p.gain; },
            reset() {},
            process(ins, outs, n) {
                const x = ins[0].re;
                const y = outs[0].re;
                for (let k = 0; k < n; k++) y[k] = x[k] * g;
                return n;
            },
        };
    },
};

export const MultiplyBlock = {
    type: 'multiply',
    label: 'Multiply',
    category: 'Math',
    summary: 'a × b, sample by sample — a squelch gate’s gain applied to audio, say.',
    inputs: [{ name: 'a', kind: REAL }, { name: 'b', kind: REAL }],
    outputs: [{ name: 'out', kind: REAL }],
    params: {},
    create: stateless((ins, outs, n) => {
        const a = ins[0].re;
        const b = ins[1].re;
        const y = outs[0].re;
        for (let k = 0; k < n; k++) y[k] = a[k] * b[k];
        return n;
    }),
};

export const AddBlock = {
    type: 'add',
    label: 'Add',
    category: 'Math',
    summary: 'a + b, sample by sample.',
    inputs: [{ name: 'a', kind: REAL }, { name: 'b', kind: REAL }],
    outputs: [{ name: 'out', kind: REAL }],
    params: {},
    create: stateless((ins, outs, n) => {
        const a = ins[0].re;
        const b = ins[1].re;
        const y = outs[0].re;
        for (let k = 0; k < n; k++) y[k] = a[k] + b[k];
        return n;
    }),
};

export const ClipBlock = {
    type: 'clip',
    label: 'Clip',
    category: 'Math',
    summary: 'Holds the signal inside ±limit.',
    inputs: [{ name: 'in', kind: REAL }],
    outputs: [{ name: 'out', kind: REAL }],
    params: {
        limit: { kind: 'number', label: 'Limit', default: 1, min: 0.001, max: 100, step: 0.01, live: true },
    },
    create() {
        let lim = 1;
        return {
            configure(p) { lim = p.limit; },
            reset() {},
            process(ins, outs, n) {
                const x = ins[0].re;
                const y = outs[0].re;
                for (let k = 0; k < n; k++) {
                    const v = x[k];
                    y[k] = v > lim ? lim : (v < -lim ? -lim : v);
                }
                return n;
            },
        };
    },
};

/**
 * A level to on or off — a Schmitt trigger, for any real signal.
 *
 * On once the input rises past "On above", off once it falls back past "Off
 * below". The gap between the two is the hysteresis: a level sitting on one
 * threshold with noise on it flickers across it on every wobble, and here it
 * has to cross the whole gap to change its mind. The two the same is a plain
 * comparator; given the wrong way round they are taken the right way round.
 *
 * "On after" and "Off after" go further, for noise bigger than the gap: a
 * crossing counts only once the input has stayed on the far side that long,
 * so a spike shorter than it changes nothing. Separate, because the two edges
 * want different things — a squelch opens fast and closes slow, a key wants
 * both short. Each change comes out that much late.
 *
 * What it puts out, all from the one decision:
 *   out    the "On" value while on, the "Off" value while off — 1 and 0 to
 *          start with, or anything: ±1 to slice FSK, 1 and 0.1 to duck
 *   gate   the input itself while on and silence while off — a gate, a
 *          squelch on any signal
 *   bits   1 and 0, a bit stream for the digital blocks (a UART, Bit sync)
 *   state  1 or 0 as a control, sent when it changes — to switch, count or
 *          plot by
 *
 * Invert swaps on and off in all four. Every number is a control input too
 * (the inspector's "control" toggle), so a threshold can follow something else
 * — the noise floor from a level detector, say.
 */
export const ThresholdBlock = {
    type: 'threshold',
    label: 'Threshold',
    category: 'Math',
    summary: 'On above one level and off below another, with minimum times — a noisy level to a clean on or off, as a level, a gate, bits or a control.',
    inputs: [{ name: 'in', kind: REAL }],
    outputs: [
        { name: 'out', kind: REAL, audio: false },
        { name: 'gate', kind: REAL },
        { name: 'bits', kind: BITS },
        { name: 'state', kind: CONTROL },
    ],
    // What its card's activity dot means.
    activity: 'On',
    params: {
        high: { kind: 'number', label: 'On above', default: 0.6, min: -1000, max: 1000, step: 0.01, live: true },
        low: { kind: 'number', label: 'Off below', default: 0.4, min: -1000, max: 1000, step: 0.01, live: true },
        onMs: { kind: 'number', label: 'On after', unit: 'ms', default: 0, min: 0, max: 5000, step: 0.5, live: true },
        offMs: { kind: 'number', label: 'Off after', unit: 'ms', default: 0, min: 0, max: 5000, step: 0.5, live: true },
        onValue: { kind: 'number', label: 'On value', default: 1, min: -1000, max: 1000, step: 0.01, live: true },
        offValue: { kind: 'number', label: 'Off value', default: 0, min: -1000, max: 1000, step: 0.01, live: true },
        invert: { kind: 'bool', label: 'Invert', default: false, live: true },
    },
    create() {
        let hi = 0.6;
        let lo = 0.4;
        let holdOn = 0;
        let holdOff = 0;
        let vOn = 1;
        let vOff = 0;
        let invert = false;
        let on = false;
        // How long the input has been asking for the other state, in samples.
        let pending = 0;
        let said = null;
        // On at any moment since the card last asked — so an on too brief to
        // be caught between two asks still lights it.
        let lit = false;
        return {
            configure(p, rate) {
                hi = Math.max(p.high, p.low);
                lo = Math.min(p.high, p.low);
                holdOn = Math.round((p.onMs / 1000) * rate);
                holdOff = Math.round((p.offMs / 1000) * rate);
                vOn = p.onValue;
                vOff = p.offValue;
                invert = !!p.invert;
            },
            reset() { on = false; pending = 0; said = null; lit = false; },
            // The card's activity dot: lit while on.
            activity() {
                const was = lit || on !== invert;
                lit = false;
                return was ? 1 : 0;
            },
            process(ins, outs, n) {
                const x = ins[0].re;
                const out = outs[0] && outs[0].re;
                const gate = outs[1] && outs[1].re;
                const bits = outs[2] && outs[2].re;
                for (let k = 0; k < n; k++) {
                    const v = x[k];
                    // Off: on once above the high one. On: off once below the
                    // low one. Between them it stays as it is.
                    const wants = on ? !(v < lo) : v > hi;
                    if (wants !== on) {
                        pending++;
                        if (pending > (wants ? holdOn : holdOff)) { on = wants; pending = 0; }
                    } else {
                        pending = 0;
                    }
                    const yes = on !== invert;
                    if (yes) lit = true;
                    if (out) out[k] = yes ? vOn : vOff;
                    if (gate) gate[k] = yes ? v : 0;
                    if (bits) bits[k] = yes ? 1 : 0;
                }
                const now = on !== invert ? 1 : 0;
                if (outs[3] && now !== said) {
                    said = now;
                    emitControl(outs[3], now);
                }
                return n;
            },
        };
    },
};

export const ComplexMultiplyBlock = {
    type: 'complex-multiply',
    label: 'Complex multiply',
    category: 'Math',
    summary: 'a × b for complex a and b.',
    inputs: [{ name: 'a', kind: COMPLEX }, { name: 'b', kind: COMPLEX }],
    outputs: [{ name: 'out', kind: COMPLEX }],
    params: {},
    create: stateless((ins, outs, n) => {
        const { re: ar, im: ai } = ins[0];
        const { re: br, im: bi } = ins[1];
        const { re: yr, im: yi } = outs[0];
        for (let k = 0; k < n; k++) {
            const r = ar[k] * br[k] - ai[k] * bi[k];
            yi[k] = ar[k] * bi[k] + ai[k] * br[k];
            yr[k] = r;
        }
        return n;
    }),
};

export const ConjugateBlock = {
    type: 'conjugate',
    label: 'Conjugate',
    category: 'Math',
    summary: 'Flips the spectrum about zero: upper becomes lower.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [{ name: 'out', kind: COMPLEX }],
    params: {},
    create: stateless((ins, outs, n) => {
        outs[0].re.set(ins[0].re.subarray(0, n));
        const x = ins[0].im;
        const y = outs[0].im;
        for (let k = 0; k < n; k++) y[k] = -x[k];
        return n;
    }),
};

export const RealPartBlock = {
    type: 'real-part',
    label: 'Real part',
    category: 'Math',
    summary: 'I alone.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [{ name: 'out', kind: REAL }],
    params: {},
    create: stateless((ins, outs, n) => {
        outs[0].re.set(ins[0].re.subarray(0, n));
        return n;
    }),
};

export const ImagPartBlock = {
    type: 'imag-part',
    label: 'Imaginary part',
    category: 'Math',
    summary: 'Q alone.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [{ name: 'out', kind: REAL }],
    params: {},
    create: stateless((ins, outs, n) => {
        outs[0].re.set(ins[0].im.subarray(0, n));
        return n;
    }),
};

export const ToComplexBlock = {
    type: 'to-complex',
    label: 'Real to complex',
    category: 'Math',
    summary: 'I from the input, Q zero — or Q from a second input.',
    inputs: [{ name: 'i', kind: REAL }, { name: 'q', kind: REAL, optional: true }],
    outputs: [{ name: 'out', kind: COMPLEX }],
    params: {},
    create: stateless((ins, outs, n) => {
        outs[0].re.set(ins[0].re.subarray(0, n));
        if (ins[1]) outs[0].im.set(ins[1].re.subarray(0, n));
        else outs[0].im.fill(0, 0, n);
        return n;
    }),
};
