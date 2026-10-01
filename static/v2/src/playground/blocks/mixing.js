// Moving spectrum about: shifting it, bringing it down to audio, and bringing a
// wide stream down to a rate a demodulator can afford.

import { COMPLEX, CONTROL, REAL, emitControl } from '../block.js';
import { Nco } from '../../lib/dsp/nco.js';
import { Decimator } from '../../lib/dsp/decimator.js';
import { designLowpass } from '../../lib/dsp/fir.js';
import { decimationForPass } from '../../lib/iqDemod.js';

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
 * The factor a Decimate block keeps one sample in: its own, or on Auto the
 * IQ Demod panel's for the rate arriving — as much as still holds the pass
 * band, so 1 on plain 12 kHz IQ, 2 at 48 kHz, up to 16 at 384 kHz.
 */
export function decimateFactor(rateHz, p) {
    return p.auto ? decimationForPass(rateHz, p.passHz) : Math.max(1, Math.round(p.factor));
}

// A filter that passes everything: the factor-1 case, which only mixes.
const UNITY = new Float32Array([1]);

/**
 * Mix a frequency down to zero, low-pass, and keep every Dth sample.
 *
 * What the IQ Demod panel's demodulators do first on a wide stream. The filter
 * passes `passHz` either side of zero and is designed to have rolled off by the
 * point the next band down folds back onto it. Its output is single precision,
 * as the panel's is.
 *
 * On Auto, the factor follows the stream, so a graph built on one IQ width
 * works on any other: whatever the factor, the centre arrives at zero, and
 * what comes after never knows the difference. At a factor of 1 nothing is
 * dropped, so nothing can fold back and there is nothing to filter: it only
 * mixes.
 *
 * Its `middle` output says where the middle of its output's band is — the
 * point the stream's edges hang from, ±rate/2 either side, past which is the
 * other edge wrapped round. Filtered and brought down, the band is new and its
 * middle is zero; only mixed, at a factor of 1, the edges moved with the
 * centre, so the middle is at minus the centre. A block that must stay clear of
 * the edges (the carrier tracker) takes it — or a number in its place. It
 * assumes the stream arriving was centred, as the receiver's is.
 *
 * Its `centre` output is its Centre, as it is now: what everything after it is
 * measured from, for a block that keeps its frequencies in the dial's terms
 * (the carrier tracker's Stream centre) to follow when the Centre moves.
 */
export const DecimateBlock = {
    type: 'decimate',
    label: 'Decimate',
    category: 'Mixing',
    summary: 'Brings a frequency to zero, filters round it and keeps every Dth sample — on Auto, as many as the stream’s width allows.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [{ name: 'out', kind: COMPLEX }, { name: 'middle', kind: CONTROL }, { name: 'centre', kind: CONTROL }],
    params: {
        // Changing either redesigns the filter and moves the rate after it,
        // so neither is offered as a control input.
        auto: { kind: 'bool', label: 'Auto factor', default: true, control: false },
        factor: { kind: 'number', label: 'Factor', default: 4, min: 1, max: 64, step: 1, control: false, showIf: (p) => !p.auto },
        frequencyHz: { ...FREQ, label: 'Centre' },
        passHz: { kind: 'number', label: 'Pass', unit: 'Hz', default: 8000, min: 100, max: 96000, step: 100, control: false },
    },
    // A graph from before Auto, or one that names its factor and says nothing
    // of Auto, means that factor: it keeps it.
    upgrade: (stored) => ('factor' in stored && !('auto' in stored) ? { ...stored, auto: false } : stored),
    rate: (inRate, p) => inRate / decimateFactor(inRate, p),
    maxOut: (n, p, inRate) => Math.ceil(n / decimateFactor(inRate, p)) + 1,
    create() {
        const dec = new Decimator();
        let inRate = 12000;
        let key = '';
        let I = new Float32Array(0);
        let Q = new Float32Array(0);
        return {
            configure(p, r) {
                inRate = r;
                const D = decimateFactor(r, p);
                const k = `${r}/${D}/${p.passHz}`;
                if (k !== key) {
                    key = k;
                    const pass = p.passHz;
                    const stop = r / D - pass;
                    dec.setFilter(D > 1 ? designLowpass((pass + stop) / 2, r, stop - pass) : UNITY, D);
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
                if (outs[1]) emitControl(outs[1], dec.D > 1 ? 0 : -dec.frequencyHz);
                if (outs[2]) emitControl(outs[2], dec.frequencyHz);
                return m;
            },
        };
    },
};
