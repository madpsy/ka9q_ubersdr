// The Noise panel's client-side stage as blocks: the impulse blanker, and its
// two noise reducers by the panel's own names — LSA (lib/nr.js) and NR
// (lib/nr2.js, stored by the panel as 'nr2', which is what this type is
// called too). Each runs the playground's own copy of the panel's engine (playground/
// noise/), which is the panel's arithmetic made to take a packet of any
// length — see the notes at the top of each copy.
//
// The panel's order holds here too, for the panel's reason: blank first, then
// reduce. An impulse is exactly what a noise model must not learn, so a
// blanker after an NR is cutting clicks the NR has already smeared.
//
// "On" switches each out without unwiring it, for hearing the difference.
// Off is a straight copy — no delay — as the panel's is; switched on again,
// it starts from nothing, as the panel's does on being re-enabled.

import { REAL, copyInto } from '../block.js';
import { NB_DEFAULTS, NB_THRESHOLD_MAX, NB_THRESHOLD_MIN, NB_WIDTH_MAX, NB_WIDTH_MIN, NoiseBlanker } from '../noise/noiseBlanker.js';
import { NR_DEFAULTS, NRProcessor } from '../noise/nr.js';
import { NR2Processor } from '../noise/nr2.js';

const IN = [{ name: 'in', kind: REAL }];
const OUT = [{ name: 'out', kind: REAL }];
const ON = { kind: 'bool', label: 'On', default: true };
const MAKEUP = { kind: 'number', label: 'Makeup gain', unit: 'dB', default: NR_DEFAULTS.makeupDb, min: -12, max: 12, step: 0.5, live: true };
const STRENGTH = { kind: 'number', label: 'Strength', unit: '%', default: NR_DEFAULTS.strength, min: 0, max: 100, step: 5, live: true };

// The panel's NR is a 2048-point FFT at four-times overlap.
const NR2_FFT = 2048;
const NR2_OVERLAP = 4;

const gainOf = (db) => Math.pow(10, (Number(db) || 0) / 20);

function applyGain(buf, n, g) {
    if (g === 1) return;
    for (let i = 0; i < n; i++) buf[i] *= g;
}

export const NoiseBlankerBlock = {
    type: 'noise-blanker',
    label: 'Noise blanker',
    category: 'Filters',
    summary: 'Cuts impulse noise — ignition, power-line arcing, fences, static crashes — out of the audio. The Noise panel’s blanker. Put it before any noise reduction.',
    inputs: IN,
    outputs: OUT,
    params: {
        on: ON,
        thresholdDb: { kind: 'number', label: 'Threshold', unit: 'dB', default: NB_DEFAULTS.thresholdDb, min: NB_THRESHOLD_MIN, max: NB_THRESHOLD_MAX, step: 1, live: true },
        widthMs: { kind: 'number', label: 'Width', unit: 'ms', default: NB_DEFAULTS.widthMs, min: NB_WIDTH_MIN, max: NB_WIDTH_MAX, step: 0.5, live: true },
    },
    create() {
        let nb = null;
        let rate = 0;
        let on = true;
        return {
            configure(p, r) {
                if (!nb || r !== rate) nb = new NoiseBlanker(r);
                else if (p.on && !on) nb.reset();
                rate = r;
                on = p.on;
                nb.setParameters({ thresholdDb: p.thresholdDb, widthMs: p.widthMs });
            },
            reset() { if (nb) nb.reset(); },
            latency() { return on && nb ? nb.latency() : 0; },
            read() {
                return nb && on
                    ? { on, pulses: nb.pulsesBlanked, cut: nb.cutFraction, reductionDb: nb.reductionDb }
                    : { on };
            },
            process(ins, outs, n) {
                if (!on) copyInto(ins[0], outs[0], n);
                else nb.process(ins[0].re, outs[0].re, n);
                return n;
            },
        };
    },
};

export const LsaBlock = {
    type: 'lsa',
    label: 'Noise reduction (LSA)',
    category: 'Filters',
    summary: 'Takes the steady band noise out from under the audio, following it as it changes — the Noise panel’s LSA, its default: no learning phase, best on voice. Strength is how deep it may cut. A carrier that never moves fades with the noise.',
    inputs: IN,
    outputs: OUT,
    params: {
        on: ON,
        strength: STRENGTH,
        makeupDb: MAKEUP,
    },
    create() {
        let nr = null;
        let rate = 0;
        let on = true;
        let gain = 1;
        return {
            configure(p, r) {
                if (!nr || r !== rate) nr = new NRProcessor(r);
                else if (p.on && !on) nr.resetLearning();
                rate = r;
                on = p.on;
                gain = gainOf(p.makeupDb);
                nr.setParameters(p.strength);
            },
            reset() { if (nr) nr.resetLearning(); },
            latency() { return on && nr ? nr.latency() : 0; },
            process(ins, outs, n) {
                if (!on) {
                    copyInto(ins[0], outs[0], n);
                    return n;
                }
                nr.process(ins[0].re, outs[0].re, n);
                applyGain(outs[0].re, n, gain);
                return n;
            },
        };
    },
};

export const Nr2Block = {
    type: 'nr2',
    label: 'Noise reduction (NR)',
    category: 'Filters',
    summary: 'The classic spectral subtraction — the Noise panel’s NR. Learns the noise first — 1.3 s at 12 kHz, less at higher rates — then subtracts it; a long window that suits CW and other narrow signals. Start it on noise, not on a signal, or press Learn again.',
    inputs: IN,
    outputs: OUT,
    params: {
        on: ON,
        strength: STRENGTH,
        floor: { kind: 'number', label: 'Spectral floor', unit: '%', default: NR_DEFAULTS.floor, min: 0, max: 10, step: 0.5, live: true },
        adaptRate: { kind: 'number', label: 'Adaptation', unit: '%', default: NR_DEFAULTS.adaptRate, min: 0.1, max: 5, step: 0.1, live: true },
        makeupDb: MAKEUP,
    },
    create() {
        let nr = null;
        let on = true;
        let gain = 1;
        return {
            configure(p) {
                // No rate in it: the panel's runs the same 2048 points at
                // whatever rate its audio is.
                if (!nr) nr = new NR2Processor(NR2_FFT, NR2_OVERLAP);
                else if (p.on && !on) nr.reset();
                on = p.on;
                gain = gainOf(p.makeupDb);
                nr.setParameters(p.strength, p.floor, p.adaptRate);
            },
            reset() { if (nr) nr.reset(); },
            command(name) { if (name === 'relearn' && nr) nr.resetLearning(); },
            latency() { return on && nr ? nr.latency() : 0; },
            read() { return { on, learning: !!(nr && on && nr.learning) }; },
            process(ins, outs, n) {
                if (!on) {
                    copyInto(ins[0], outs[0], n);
                    return n;
                }
                nr.process(ins[0].re, outs[0].re, n);
                applyGain(outs[0].re, n, gain);
                return n;
            },
        };
    },
};
