// Filtering a complex signal, and turning it into something to hear or measure.

import { COMPLEX, REAL } from '../block.js';
import { ComplexFir, designLowpass } from '../../lib/dsp/fir.js';
import { Discriminator, complexPower, envelope } from '../../lib/dsp/detectors.js';
import { EcssTracker, LockMute, SIDEBANDS, TRACK_DEFAULT, TRACK_MAX, TRACK_MIN } from '../../lib/ecss.js';

/**
 * A windowed-sinc low-pass run over I and Q. On a complex signal that passes
 * `cutoffHz` either side of zero and keeps the two sides apart, so after a
 * shift it is a band-pass that knows one sideband from the other.
 */
export const LowpassBlock = {
    type: 'lowpass',
    label: 'Low-pass (complex)',
    category: 'Filters',
    summary: 'Passes the cutoff either side of zero. Shift a signal to zero first to select it.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [{ name: 'out', kind: COMPLEX }],
    params: {
        cutoffHz: { kind: 'number', label: 'Cutoff', unit: 'Hz', default: 1350, min: 10, max: 96000, step: 10 },
        // 0 is the proportional default — a fifth of the cutoff, 80 to 400 Hz.
        transitionHz: { kind: 'number', label: 'Transition', unit: 'Hz', default: 0, min: 0, max: 20000, step: 10 },
    },
    create() {
        const fir = new ComplexFir();
        let key = '';
        return {
            configure(p, r) {
                const k = `${p.cutoffHz}/${p.transitionHz}/${r}`;
                if (k !== key) {
                    key = k;
                    fir.setTaps(designLowpass(p.cutoffHz, r, p.transitionHz));
                }
            },
            reset() { fir.reset(); },
            read() { return { taps: fir.n }; },
            latency: () => Math.max(0, (fir.n - 1) / 2),
            process(ins, outs, n) {
                fir.process(ins[0].re, ins[0].im, outs[0].re, outs[0].im, n);
                return n;
            },
        };
    },
};

/** |z|^2 per sample. */
export const PowerBlock = {
    type: 'power',
    label: 'Power',
    category: 'Detectors',
    summary: 'Instantaneous power, |z|², per sample — what a squelch measures.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [{ name: 'out', kind: REAL }],
    params: {},
    create() {
        return {
            configure() {},
            reset() {},
            process(ins, outs, n) {
                complexPower(ins[0].re, ins[0].im, outs[0].re, n);
                return n;
            },
        };
    },
};

/** |z|: the AM detector. */
export const EnvelopeBlock = {
    type: 'envelope',
    label: 'Envelope (AM)',
    category: 'Detectors',
    summary: 'The magnitude, |z|. Follow it with a DC block to take the carrier off.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [{ name: 'out', kind: REAL }],
    params: {},
    create() {
        return {
            configure() {},
            reset() {},
            process(ins, outs, n) {
                envelope(ins[0].re, ins[0].im, outs[0].re, n);
                return n;
            },
        };
    },
};

/** The phase advanced per sample, scaled so `deviationHz` reads 1: FM. */
export const DiscriminatorBlock = {
    type: 'fm-discriminator',
    label: 'FM discriminator',
    category: 'Detectors',
    summary: 'Instantaneous frequency; full deviation comes out at 1.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [{ name: 'out', kind: REAL }],
    params: {
        deviationHz: { kind: 'number', label: 'Deviation', unit: 'Hz', default: 5000, min: 10, max: 100000, step: 10, live: true },
    },
    create() {
        const disc = new Discriminator();
        let rate = 12000;
        return {
            configure(p, r) { disc.deviationHz = p.deviationHz; rate = r; },
            reset() { disc.reset(); },
            // The difference of two neighbouring samples sits between them.
            latency: () => 0.5,
            process(ins, outs, n) {
                disc.process(ins[0].re, ins[0].im, outs[0].re, n, rate);
                return n;
            },
        };
    },
};

/**
 * The SAM and ECSS carrier tracker (lib/ecss.js): finds the carrier near
 * `centreHz`, locks to it, and demodulates against it — both sidebands for SAM,
 * one or a weighted pair for ECSS.
 *
 * Four outputs, because the IQ Demod panel uses all four: the audio, the
 * power in its passband for a squelch, the carrier's level for an AGC to
 * level against, and a gain that is 0 until it locks — to multiply the audio
 * by, after the AGC, for silence while it searches (1 throughout with that
 * off). The first three are single precision, as the panel's are.
 */
export const CarrierTrackerBlock = {
    type: 'carrier-tracker',
    label: 'Carrier tracker (SAM/ECSS)',
    category: 'Detectors',
    summary: 'Locks to an AM carrier and demodulates against it.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [
        { name: 'audio', kind: REAL },
        { name: 'power', kind: REAL },
        { name: 'carrier', kind: REAL },
        { name: 'lock', kind: REAL },
    ],
    params: {
        mode: {
            kind: 'choice',
            label: 'Mode',
            default: 'ecss',
            options: [{ value: 'sam', label: 'SAM' }, { value: 'ecss', label: 'ECSS' }],
        },
        centreHz: { kind: 'number', label: 'Carrier near', unit: 'Hz', default: 0, min: -192000, max: 192000, step: 10, live: true },
        // Where the stream arriving here was mixed from, if a decimator ahead
        // of this moved it — so the tracker knows where the stream's edges are.
        baseHz: { kind: 'number', label: 'Stream centre', unit: 'Hz', default: 0, min: -192000, max: 192000, step: 10, live: true },
        // Where the middle of the band arriving is, which its edges hang from:
        // zero unless the stream was mixed without being filtered. A
        // decimator's `middle` output says, at whatever factor it is on.
        middleHz: { kind: 'number', label: 'Band middle', unit: 'Hz', default: 0, min: -192000, max: 192000, step: 10, live: true },
        widthHz: { kind: 'number', label: 'Width', unit: 'Hz', default: 4500, min: 300, max: 20000, step: 50 },
        sideband: {
            kind: 'choice',
            label: 'Sideband',
            default: 'both',
            options: SIDEBANDS.map((s) => ({ value: s, label: s === 'both' ? 'Both' : s === 'auto' ? 'Auto' : s.toUpperCase() })),
        },
        trackHz: { kind: 'number', label: 'Tracking range', unit: 'Hz', default: TRACK_DEFAULT, min: TRACK_MIN, max: TRACK_MAX, step: 10 },
        lockMute: { kind: 'bool', label: 'Mute until locked', default: true },
    },
    create() {
        const tracker = new EcssTracker();
        const mute = new LockMute();
        let muting = true;
        let rate = 12000;
        let Y = new Float32Array(0);
        let P = new Float32Array(0);
        let R = new Float32Array(0);
        let kind = null;
        return {
            configure(p, r) {
                // Arriving in a mode is a fresh search, as it is in the panel —
                // but SAM and ECSS are the same carrier, so moving between them
                // keeps it.
                if (kind === null) tracker.reset();
                kind = p.mode;
                muting = p.lockMute;
                rate = r;
                const plan = {
                    kind: p.mode,
                    centreHz: p.centreHz,
                    widthHz: p.widthHz,
                    sideband: p.sideband,
                    trackHz: p.trackHz,
                };
                tracker.configure(plan, r, (cutoffHz, transitionHz) => designLowpass(cutoffHz, r, transitionHz), p.baseHz);
                tracker.middleHz = p.middleHz;
            },
            reset() { tracker.reset(); mute.reset(); },
            latency: () => tracker.latencySamples,
            read() {
                return {
                    state: tracker.state,
                    locked: tracker.locked,
                    carrierHz: tracker.locked ? tracker.readoutHz : null,
                    side: tracker.side,
                };
            },
            process(ins, outs, n) {
                if (Y.length < n) {
                    Y = new Float32Array(n);
                    P = new Float32Array(n);
                    R = new Float32Array(n);
                }
                tracker.process(ins[0].re, ins[0].im, n, Y, P, R);
                for (let k = 0; k < n; k++) {
                    outs[0].re[k] = Y[k];
                    outs[1].re[k] = P[k];
                    outs[2].re[k] = R[k];
                }
                if (muting) mute.process(tracker.locked, outs[3].re, n, rate);
                else {
                    mute.reset();
                    outs[3].re.fill(1, 0, n);
                }
                return n;
            },
        };
    },
};
