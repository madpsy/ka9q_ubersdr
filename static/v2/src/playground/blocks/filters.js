// Filters: complex ones for picking a signal out of the stream, real ones for
// shaping the audio after it has been demodulated.
//
// The FIRs are linear-phase — they delay every frequency equally, by half
// their length — and that delay is each one's latency(). The biquads are IIR:
// a few multiplies a sample and next to no delay, but a phase that bends with
// frequency, which their latency note says.

import { COMPLEX, REAL } from '../block.js';
import {
    ComplexFir, ComplexTapFir, RealFir, designBandpass, designBandstop, designComplexBandpass,
    designHighpass, designLowpass,
} from '../../lib/dsp/fir.js';
import { BIQUAD_TYPES, Biquad } from '../../lib/dsp/biquad.js';

const HZ = (label, def, min, max) => ({ kind: 'number', label, unit: 'Hz', default: def, min, max, step: 10 });
// 0 is the proportional default — a fifth of the cutoff (or half-width),
// bounded to 80–400 Hz. See TRANSITION_FRACTION in lib/dsp/fir.js.
const TRANSITION = { kind: 'number', label: 'Transition', unit: 'Hz', default: 0, min: 0, max: 20000, step: 10 };
const firLatency = (fir) => () => Math.max(0, (fir.n - 1) / 2);

/** A complex FIR with real taps, redesigned only when what it depends on changes. */
function complexReal(design, keyOf) {
    return () => {
        const fir = new ComplexFir();
        let key = '';
        return {
            configure(p, r) {
                const k = `${keyOf(p)}/${r}`;
                if (k !== key) {
                    key = k;
                    fir.setTaps(design(p, r));
                }
            },
            reset() { fir.reset(); },
            read() { return { taps: fir.n }; },
            latency: firLatency(fir),
            process(ins, outs, n) {
                fir.process(ins[0].re, ins[0].im, outs[0].re, outs[0].im, n);
                return n;
            },
        };
    };
}

/** A real FIR on a real signal, likewise. */
function real(design, keyOf) {
    return () => {
        const fir = new RealFir();
        let key = '';
        return {
            configure(p, r) {
                const k = `${keyOf(p)}/${r}`;
                if (k !== key) {
                    key = k;
                    fir.setTaps(design(p, r));
                }
            },
            reset() { fir.reset(); },
            read() { return { taps: fir.n }; },
            latency: firLatency(fir),
            process(ins, outs, n) {
                fir.process(ins[0].re, outs[0].re, n);
                return n;
            },
        };
    };
}

const C_IN = [{ name: 'in', kind: COMPLEX }];
const C_OUT = [{ name: 'out', kind: COMPLEX }];
const R_IN = [{ name: 'in', kind: REAL }];
const R_OUT = [{ name: 'out', kind: REAL }];

// ── complex ─────────────────────────────────────────────────────────────────

export const ComplexHighpassBlock = {
    type: 'complex-highpass',
    label: 'High-pass (complex)',
    category: 'Filters',
    summary: 'Passes everything more than the cutoff from zero, on both sides.',
    inputs: C_IN,
    outputs: C_OUT,
    params: { cutoffHz: HZ('Cutoff', 300, 10, 96000), transitionHz: TRANSITION },
    create: complexReal(
        (p, r) => designHighpass(p.cutoffHz, r, p.transitionHz),
        (p) => `${p.cutoffHz}/${p.transitionHz}`,
    ),
};

/**
 * One band, on one side of zero: pick a signal out of the stream without
 * shifting it first. The low and high edges are offsets from the stream's
 * centre and may be negative; the mirror image of the band is rejected.
 */
export const ComplexBandpassBlock = {
    type: 'complex-bandpass',
    label: 'Band-pass (complex)',
    category: 'Filters',
    summary: 'Passes one band of the stream, on one side of zero — no shift needed.',
    inputs: C_IN,
    outputs: C_OUT,
    params: {
        lowHz: HZ('Low edge', 300, -192000, 192000),
        highHz: HZ('High edge', 3000, -192000, 192000),
        transitionHz: TRANSITION,
    },
    create() {
        const fir = new ComplexTapFir();
        let key = '';
        return {
            configure(p, r) {
                const k = `${p.lowHz}/${p.highHz}/${p.transitionHz}/${r}`;
                if (k !== key) {
                    key = k;
                    fir.setTaps(designComplexBandpass(p.lowHz, p.highHz, r, p.transitionHz));
                }
            },
            reset() { fir.reset(); },
            read() { return { taps: fir.n }; },
            latency: firLatency(fir),
            process(ins, outs, n) {
                fir.process(ins[0].re, ins[0].im, outs[0].re, outs[0].im, n);
                return n;
            },
        };
    },
};

// ── audio ───────────────────────────────────────────────────────────────────

export const AudioLowpassBlock = {
    type: 'audio-lowpass',
    label: 'Low-pass (audio)',
    category: 'Filters',
    summary: 'Linear-phase FIR: passes audio below the cutoff.',
    inputs: R_IN,
    outputs: R_OUT,
    params: { cutoffHz: HZ('Cutoff', 3000, 10, 96000), transitionHz: TRANSITION },
    create: real((p, r) => designLowpass(p.cutoffHz, r, p.transitionHz), (p) => `${p.cutoffHz}/${p.transitionHz}`),
};

export const AudioHighpassBlock = {
    type: 'audio-highpass',
    label: 'High-pass (audio)',
    category: 'Filters',
    summary: 'Linear-phase FIR: passes audio above the cutoff — hum and rumble out.',
    inputs: R_IN,
    outputs: R_OUT,
    params: { cutoffHz: HZ('Cutoff', 300, 10, 96000), transitionHz: TRANSITION },
    create: real((p, r) => designHighpass(p.cutoffHz, r, p.transitionHz), (p) => `${p.cutoffHz}/${p.transitionHz}`),
};

export const AudioBandpassBlock = {
    type: 'audio-bandpass',
    label: 'Band-pass (audio)',
    category: 'Filters',
    summary: 'Linear-phase FIR: passes the audio between two edges.',
    inputs: R_IN,
    outputs: R_OUT,
    params: { lowHz: HZ('Low edge', 300, 0, 96000), highHz: HZ('High edge', 2700, 10, 96000), transitionHz: TRANSITION },
    create: real((p, r) => designBandpass(p.lowHz, p.highHz, r, p.transitionHz), (p) => `${p.lowHz}/${p.highHz}/${p.transitionHz}`),
};

export const AudioBandstopBlock = {
    type: 'audio-bandstop',
    label: 'Band-stop (audio)',
    category: 'Filters',
    summary: 'Linear-phase FIR: removes the audio between two edges.',
    inputs: R_IN,
    outputs: R_OUT,
    params: { lowHz: HZ('Low edge', 900, 0, 96000), highHz: HZ('High edge', 1100, 10, 96000), transitionHz: TRANSITION },
    create: real((p, r) => designBandstop(p.lowHz, p.highHz, r, p.transitionHz), (p) => `${p.lowHz}/${p.highHz}/${p.transitionHz}`),
};

// ── IIR ─────────────────────────────────────────────────────────────────────

const IIR_NOTE = 'IIR: next to no delay, but the phase varies with frequency.';

/** One biquad section in any of the cookbook's shapes. */
export const BiquadBlock = {
    type: 'biquad',
    label: 'Biquad (IIR EQ)',
    category: 'Filters',
    summary: 'A cheap second-order filter: low/high/band-pass, notch, peaking or shelf.',
    latencyNote: IIR_NOTE,
    inputs: R_IN,
    outputs: R_OUT,
    params: {
        shape: {
            kind: 'choice',
            label: 'Shape',
            default: 'peaking',
            options: BIQUAD_TYPES.map((t) => ({ value: t, label: t[0].toUpperCase() + t.slice(1).replace('shelf', ' shelf').replace('pass', '-pass') })),
        },
        frequencyHz: { ...HZ('Frequency', 1000, 1, 96000), live: true },
        q: { kind: 'number', label: 'Q', default: 0.707, min: 0.05, max: 50, step: 0.01, live: true },
        gainDb: { kind: 'number', label: 'Gain', unit: 'dB', default: 0, min: -40, max: 40, step: 0.5, live: true },
    },
    create() {
        const bq = new Biquad();
        return {
            configure(p, r) { bq.configure(p.shape, p.frequencyHz, p.q, p.gainDb, r); },
            reset() { bq.reset(); },
            latency: () => 0,
            process(ins, outs, n) {
                bq.process(ins[0].re, outs[0].re, n);
                return n;
            },
        };
    },
};

/**
 * A notch: one frequency taken out — a heterodyne, a carrier whistling through
 * a sideband. Set by the width of the hole rather than by Q, which is the
 * figure an operator thinks in.
 */
export const NotchBlock = {
    type: 'notch',
    label: 'Notch',
    category: 'Filters',
    summary: 'Takes out one frequency — a whistle, a heterodyne.',
    latencyNote: IIR_NOTE,
    inputs: R_IN,
    outputs: R_OUT,
    params: {
        frequencyHz: { ...HZ('Frequency', 1000, 1, 96000), live: true },
        widthHz: { kind: 'number', label: 'Width', unit: 'Hz', default: 50, min: 1, max: 5000, step: 1, live: true },
    },
    create() {
        const bq = new Biquad();
        return {
            configure(p, r) { bq.configure('notch', p.frequencyHz, p.frequencyHz / p.widthHz, 0, r); },
            reset() { bq.reset(); },
            latency: () => 0,
            process(ins, outs, n) {
                bq.process(ins[0].re, outs[0].re, n);
                return n;
            },
        };
    },
};
