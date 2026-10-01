// A whole demodulator in one block: the IQ Demod panel's own.
//
// The other blocks are the parts a demodulator is made of. This is the
// assembled article — DemodChain from lib/iqDemod.js, the very object each of
// the panel's demodulators is — so it sounds exactly as the panel does, mode
// for mode, and is where to start for anyone who wants a receiver rather than
// a kit. Its Expand (playground/expand.js) swaps it for the same thing drawn
// out in blocks, to take apart.

import { COMPLEX, CONTROL, REAL, emitControl } from '../block.js';
import { DemodChain, decimationFor, passbandFor, planFor, workingRate } from '../../lib/iqDemod.js';
import { SIDEBANDS, TRACK_DEFAULT, TRACK_MAX, TRACK_MIN } from '../../lib/ecss.js';

export const DEMOD_MODE_OPTIONS = [
    { value: 'usb', label: 'USB' }, { value: 'lsb', label: 'LSB' },
    { value: 'cwu', label: 'CW-U' }, { value: 'cwl', label: 'CW-L' },
    { value: 'am', label: 'AM' }, { value: 'sam', label: 'SAM' }, { value: 'ecss', label: 'ECSS' },
    { value: 'nfm', label: 'NFM' },
];

// A setting only some modes use is shown only in those modes.
const modeIn = (...modes) => (p) => modes.includes(p.mode);

/**
 * The plan a demodulator block's settings make at `rateHz`: planFor's, with the
 * offset applied here and held so the passband stays inside the stream.
 *
 * planFor clamps the offset against the IQ Demod panel's own idea of the
 * stream's width, which is the panel's to keep; a block may be anywhere in a
 * graph, after a decimator or on a file, so it works the limit out from the
 * rate it is actually given. The plan is otherwise planFor's, field for field
 * — every mode's centre moves one for one with the offset — so the chain is
 * the panel's chain.
 */
export function demodPlan(p, rateHz) {
    const rate = rateHz > 0 ? rateHz : 12000;
    const settings = {
        mode: p.mode, offsetHz: 0, widthHz: p.widthHz, pitchHz: p.pitchHz,
        sideband: p.sideband, trackHz: p.trackHz, lowCutHz: p.lowCutHz,
    };
    const base = planFor(settings);
    const band = passbandFor(p.mode, 0, p.widthHz, p.sideband, p.lowCutHz);
    const lo = -rate / 2 - band.lo;
    const hi = rate / 2 - band.hi;
    const off = lo > hi ? 0 : Math.round(Math.max(lo, Math.min(hi, Number(p.offsetHz) || 0)));
    return { ...base, centreHz: base.centreHz + off };
}

export const DemodulatorBlock = {
    type: 'demodulator',
    label: 'Demodulator',
    category: 'Radio',
    summary: 'A complete receiver — the IQ Demod panel’s own — in one block. Expand it to see inside.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [
        { name: 'audio', kind: REAL },
        // The power in its passband, in dBFS — what its squelch measures.
        { name: 'signal', kind: CONTROL },
    ],
    params: {
        mode: { kind: 'choice', label: 'Mode', default: 'usb', options: DEMOD_MODE_OPTIONS },
        offsetHz: { kind: 'number', label: 'Offset', unit: 'Hz', default: 0, min: -192000, max: 192000, step: 10, live: true },
        widthHz: { kind: 'number', label: 'Width', unit: 'Hz', default: 2700, min: 50, max: 20000, step: 50 },
        lowCutHz: { kind: 'number', label: 'Low cut (SSB)', unit: 'Hz', default: 50, min: 0, max: 1000, step: 10, showIf: modeIn('usb', 'lsb') },
        pitchHz: { kind: 'number', label: 'CW pitch', unit: 'Hz', default: 700, min: 300, max: 1200, step: 10, live: true, showIf: modeIn('cwu', 'cwl') },
        sideband: {
            kind: 'choice', label: 'Sideband (ECSS)', default: 'both', showIf: modeIn('ecss'),
            options: SIDEBANDS.map((s) => ({ value: s, label: s === 'both' ? 'Both' : s === 'auto' ? 'Auto' : s.toUpperCase() })),
        },
        trackHz: { kind: 'number', label: 'Tracking range', unit: 'Hz', default: TRACK_DEFAULT, min: TRACK_MIN, max: TRACK_MAX, step: 10, showIf: modeIn('sam', 'ecss') },
        agc: { kind: 'bool', label: 'AGC', default: true },
        gain: { kind: 'number', label: 'Gain', unit: '×', default: 1, min: 0, max: 4, step: 0.05, live: true },
        squelchDb: { kind: 'number', label: 'Squelch', unit: 'dBFS', default: -60, min: -60, max: 0, step: 1, live: true },
        lockMute: { kind: 'bool', label: 'Mute until locked (SAM/ECSS)', default: true, showIf: modeIn('sam', 'ecss') },
    },
    rate: (inRate, p) => workingRate(inRate, demodPlan(p, inRate)),
    // Never more out than in: a decimating chain puts out fewer.
    maxOut: (n) => n + 1,
    create() {
        const chain = new DemodChain();
        let plan = null;
        let rate = 12000;
        let p = {};
        return {
            configure(params, r) {
                p = params;
                rate = r;
                plan = demodPlan(params, r);
                // At once, not at the first packet: its filters are what its
                // latency is read from, and the editor shows that before
                // anything runs. Configuring again with the same plan is free.
                chain.configure(plan, rate);
            },
            reset() { chain.reset(); },
            latency() {
                if (!chain.plan) return 0;
                // Everything in input samples: the decimator's filter at the
                // input rate, the chain's own after it at D times fewer.
                const D = chain.D || 1;
                const front = D > 1 && chain.front.n ? (chain.front.n - 1) / 2 : 0;
                const own = chain.ecss && (chain.plan.kind === 'ecss' || chain.plan.kind === 'sam')
                    ? chain.ecss.latencySamples
                    : Math.max(0, (chain.fir.n - 1) / 2);
                return front + own * D;
            },
            read() {
                return {
                    sigDb: chain.sigDb, open: chain.gateOpen, ecss: chain.ecssStatus,
                    mode: p.mode, decimation: decimationFor(rate, plan || demodPlan(p, rate)),
                };
            },
            process(ins, outs, n) {
                chain.configure(plan, rate);
                const audio = chain.process(ins[0].re, ins[0].im, n, { agc: p.agc, gain: p.gain, squelchDb: p.squelchDb, lockMute: p.lockMute });
                const m = audio ? chain.outFrames : 0;
                for (let k = 0; k < m; k++) outs[0].re[k] = audio[k];
                if (outs[1]) emitControl(outs[1], chain.sigDb);
                return m;
            },
        };
    },
};
