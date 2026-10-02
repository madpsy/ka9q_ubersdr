// Shaping audio and deciding whether to let it through: DC block, de-emphasis,
// AGC, and the squelch's two halves.
//
// The lib/dsp versions of the first three work in place. Here the input may be
// feeding other blocks too, so each copies to its output first and works on
// that.

import { CONTROL, REAL, copyInto, emitControl } from '../block.js';
import {
    AGC_ATTACK_SEC, AGC_CARRIER_LEVEL, AGC_DECAY_SEC, AGC_MAX_GAIN, AGC_REFERRED_SMOOTH_SEC, AGC_TARGET,
    Agc, DC_CORNER_HZ, DEEMPHASIS_SEC, DcBlock, Deemphasis,
} from '../../lib/dsp/conditioning.js';
import {
    PowerDetector, SQUELCH_ATTACK_SEC, SQUELCH_DECAY_SEC, SQUELCH_HANG_SEC, SQUELCH_HYSTERESIS_DB,
    SQUELCH_OPEN_SEC, SQUELCH_SHUT_SEC, SquelchGate,
} from '../../lib/dsp/squelch.js';

const IN = [{ name: 'in', kind: REAL }];
const OUT = [{ name: 'out', kind: REAL }];
const SECONDS = (label, def, min, max, step) => ({ kind: 'number', label, unit: 's', default: def, min, max, step, live: true });

export const DcBlockerBlock = {
    type: 'dc-block',
    label: 'DC block',
    category: 'Audio',
    summary: 'A first-order high-pass: takes off a carrier, an offset or a tuning error.',
    inputs: IN,
    outputs: OUT,
    params: {
        cornerHz: { kind: 'number', label: 'Corner', unit: 'Hz', default: DC_CORNER_HZ, min: 1, max: 1000, step: 1, live: true },
    },
    create() {
        const dc = new DcBlock();
        let rate = 12000;
        return {
            configure(p, r) { dc.cornerHz = p.cornerHz; rate = r; },
            reset() { dc.reset(); },
            process(ins, outs, n) {
                copyInto(ins[0], outs[0], n);
                dc.process(outs[0].re, n, rate);
                return n;
            },
        };
    },
};

export const DeemphasisBlock = {
    type: 'deemphasis',
    label: 'De-emphasis',
    category: 'Audio',
    summary: 'Undoes an FM transmitter’s pre-emphasis: 750 µs for NFM, 50 or 75 µs for broadcast.',
    inputs: IN,
    outputs: OUT,
    params: {
        tauSec: SECONDS('Time constant', DEEMPHASIS_SEC, 1e-6, 0.01, 1e-6),
    },
    create() {
        const de = new Deemphasis();
        let rate = 12000;
        return {
            configure(p, r) { de.tauSec = p.tauSec; rate = r; },
            reset() { de.reset(); },
            process(ins, outs, n) {
                copyInto(ins[0], outs[0], n);
                de.process(outs[0].re, n, rate);
                return n;
            },
        };
    },
};

/**
 * Levels its input towards `target`. With the `ref` input connected — a
 * carrier tracker's carrier output — it levels against that while it is
 * non-zero, which is how the panel's SAM and ECSS do it.
 */
export const AgcBlock = {
    type: 'agc',
    label: 'AGC',
    category: 'Audio',
    summary: 'Automatic gain control, against the audio or against a reference.',
    inputs: [{ name: 'in', kind: REAL }, { name: 'ref', kind: REAL, optional: true, audio: false }],
    outputs: OUT,
    params: {
        apply: { kind: 'bool', label: 'On', default: true },
        target: { kind: 'number', label: 'Target', default: AGC_TARGET, min: 0.01, max: 1, step: 0.01, live: true },
        attackSec: SECONDS('Attack', AGC_ATTACK_SEC, 0.0001, 1, 0.0001),
        decaySec: SECONDS('Decay', AGC_DECAY_SEC, 0.01, 10, 0.01),
        maxGain: { kind: 'number', label: 'Max gain', default: AGC_MAX_GAIN, min: 1, max: 100000, step: 1, live: true },
        carrierLevel: { kind: 'number', label: 'Carrier level', default: AGC_CARRIER_LEVEL, min: 0.01, max: 10, step: 0.01, live: true },
        referredSmoothSec: SECONDS('Reference smoothing', AGC_REFERRED_SMOOTH_SEC, 0.001, 1, 0.001),
    },
    create() {
        const agc = new Agc();
        let rate = 12000;
        let apply = true;
        return {
            configure(p, r) {
                rate = r;
                apply = p.apply;
                agc.target = p.target;
                agc.attackSec = p.attackSec;
                agc.decaySec = p.decaySec;
                agc.maxGain = p.maxGain;
                agc.carrierLevel = p.carrierLevel;
                agc.referredSmoothSec = p.referredSmoothSec;
            },
            reset() { agc.reset(); },
            process(ins, outs, n) {
                copyInto(ins[0], outs[0], n);
                if (ins[1]) agc.processReferred(outs[0].re, ins[1].re, n, rate, apply);
                else agc.process(outs[0].re, n, rate, apply);
                return n;
            },
        };
    },
};

/** Power smoothed fast up and slow down: the squelch's level. */
export const LevelDetectorBlock = {
    type: 'level-detector',
    label: 'Level detector',
    category: 'Squelch',
    summary: 'Smooths a power reading: quick to rise, slow to fall.',
    inputs: IN,
    outputs: [...OUT, { name: 'db', kind: CONTROL }],
    params: {
        attackSec: SECONDS('Attack', SQUELCH_ATTACK_SEC, 0.0001, 1, 0.0001),
        decaySec: SECONDS('Decay', SQUELCH_DECAY_SEC, 0.001, 5, 0.001),
    },
    create() {
        const det = new PowerDetector();
        let rate = 12000;
        return {
            configure(p, r) { det.attackSec = p.attackSec; det.decaySec = p.decaySec; rate = r; },
            reset() { det.reset(); },
            read() {
                const v = det.level;
                return { level: v, db: v > 0 ? 10 * Math.log10(v) : null };
            },
            process(ins, outs, n) {
                det.process(ins[0].re, outs[0].re, n, rate);
                if (outs[1]) emitControl(outs[1], det.level > 0 ? 10 * Math.log10(det.level) : -200);
                return n;
            },
        };
    },
};

/**
 * Opens on a level over the threshold and shuts below it, less the hysteresis,
 * once the hang has run out. Puts out the gate's gain, 0 to 1 — multiply audio
 * by it to squelch that audio.
 */
export const SquelchBlock = {
    type: 'squelch',
    label: 'Squelch gate',
    category: 'Squelch',
    summary: 'A gain of 1 or 0 from a level against a threshold, ramped so it never clicks.',
    inputs: IN,
    outputs: [...OUT, { name: 'open', kind: CONTROL }],
    params: {
        enabled: { kind: 'bool', label: 'On', default: true },
        thresholdDb: { kind: 'number', label: 'Threshold', unit: 'dBFS', default: -40, min: -160, max: 20, step: 1, live: true },
        hysteresisDb: { kind: 'number', label: 'Hysteresis', unit: 'dB', default: SQUELCH_HYSTERESIS_DB, min: 0, max: 40, step: 0.5, live: true },
        hangSec: SECONDS('Hang', SQUELCH_HANG_SEC, 0, 10, 0.01),
        openSec: SECONDS('Open', SQUELCH_OPEN_SEC, 0.0001, 1, 0.0001),
        shutSec: SECONDS('Shut', SQUELCH_SHUT_SEC, 0.0001, 1, 0.0001),
    },
    create() {
        const gate = new SquelchGate();
        let rate = 12000;
        return {
            configure(p, r) {
                rate = r;
                gate.enabled = p.enabled;
                gate.thresholdDb = p.thresholdDb;
                gate.hysteresisDb = p.hysteresisDb;
                gate.hangSec = p.hangSec;
                gate.openSec = p.openSec;
                gate.shutSec = p.shutSec;
            },
            reset() { gate.reset(); },
            read() { return { open: gate.open }; },
            process(ins, outs, n) {
                gate.process(ins[0].re, outs[0].re, n, rate);
                if (outs[1]) emitControl(outs[1], gate.open ? 1 : 0);
                return n;
            },
        };
    },
};
