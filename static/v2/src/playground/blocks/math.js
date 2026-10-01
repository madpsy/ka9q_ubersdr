// Arithmetic on signals, and moving between real and complex.

import { COMPLEX, REAL } from '../block.js';

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
