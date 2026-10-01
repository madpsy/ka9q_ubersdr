// Moving spectrum about: shifting it, bringing it down to audio, and bringing a
// wide stream down to a rate a demodulator can afford.

import { COMPLEX, REAL } from '../block.js';
import { Nco } from '../../lib/dsp/nco.js';
import { Decimator } from '../../lib/dsp/decimator.js';
import { designLowpass } from '../../lib/dsp/fir.js';

const FREQ = { kind: 'number', label: 'Frequency', unit: 'Hz', default: 0, min: -192000, max: 192000, step: 10, live: true };

/** Multiply by e^(j2*pi*f*t): everything moves up by f, or down for negative f. */
export const ShiftBlock = {
    type: 'shift',
    label: 'Frequency shift',
    category: 'Mixing',
    summary: 'Moves the whole spectrum by a frequency — negative to bring a signal down to zero.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [{ name: 'out', kind: COMPLEX }],
    params: { frequencyHz: FREQ },
    create() {
        const nco = new Nco();
        let rate = 12000;
        return {
            configure(p, r) { nco.frequencyHz = p.frequencyHz; rate = r; },
            reset() { nco.reset(); },
            process(ins, outs, n) {
                nco.mix(ins[0].re, ins[0].im, outs[0].re, outs[0].im, n, rate);
                return n;
            },
        };
    },
};

/**
 * Re{x * e^(j2*pi*f*t)}: shift, then keep the real part. The last step of SSB
 * and CW — a positive frequency puts what is above zero at audio, a negative
 * one what is below it.
 */
export const ToAudioBlock = {
    type: 'to-audio',
    label: 'Shift to audio',
    category: 'Mixing',
    summary: 'Shifts by a frequency and keeps the real part: SSB and CW’s detector.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [{ name: 'out', kind: REAL }],
    params: { frequencyHz: FREQ },
    create() {
        const nco = new Nco();
        let rate = 12000;
        return {
            configure(p, r) { nco.frequencyHz = p.frequencyHz; rate = r; },
            reset() { nco.reset(); },
            process(ins, outs, n) {
                nco.mixReal(ins[0].re, ins[0].im, outs[0].re, n, rate);
                return n;
            },
        };
    },
};

/**
 * Mix a frequency down to zero, low-pass, and keep every Dth sample.
 *
 * What the IQ Demod panel's demodulators do first on a wide stream. The filter
 * passes `passHz` either side of zero and is designed to have rolled off by the
 * point the next band down folds back onto it. Its output is single precision,
 * as the panel's is.
 */
export const DecimateBlock = {
    type: 'decimate',
    label: 'Decimate',
    category: 'Mixing',
    summary: 'Brings a frequency to zero, filters round it and keeps every Dth sample.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [{ name: 'out', kind: COMPLEX }],
    params: {
        // Changing either redesigns the filter and moves the rate after it,
        // so neither is offered as a control input.
        factor: { kind: 'number', label: 'Factor', default: 4, min: 1, max: 64, step: 1, control: false },
        frequencyHz: { ...FREQ, label: 'Centre' },
        passHz: { kind: 'number', label: 'Pass', unit: 'Hz', default: 8000, min: 100, max: 96000, step: 100, control: false },
    },
    rate: (inRate, p) => inRate / Math.max(1, Math.round(p.factor)),
    maxOut: (n, p) => Math.ceil(n / Math.max(1, Math.round(p.factor))) + 1,
    create() {
        const dec = new Decimator();
        let inRate = 12000;
        let key = '';
        let I = new Float32Array(0);
        let Q = new Float32Array(0);
        return {
            configure(p, r) {
                inRate = r;
                const D = Math.max(1, Math.round(p.factor));
                const k = `${r}/${D}/${p.passHz}`;
                if (k !== key) {
                    key = k;
                    const pass = p.passHz;
                    const stop = r / D - pass;
                    dec.setFilter(designLowpass((pass + stop) / 2, r, stop - pass), D);
                }
                dec.frequencyHz = p.frequencyHz;
            },
            reset() { dec.reset(); },
            // Its filter's half-length, at the rate arriving.
            latency: () => Math.max(0, (dec.n - 1) / 2),
            process(ins, outs, n) {
                const max = Math.ceil(n / dec.D) + 1;
                if (I.length < max) {
                    I = new Float32Array(max);
                    Q = new Float32Array(max);
                }
                const m = dec.process(ins[0].re, ins[0].im, I, Q, n, inRate);
                for (let k = 0; k < m; k++) {
                    outs[0].re[k] = I[k];
                    outs[0].im[k] = Q[k];
                }
                return m;
            },
        };
    },
};
