// An IQ Demod panel demodulator, drawn out as a playground graph.
//
// The panel's DemodChain is a fixed arrangement of the lib/dsp primitives; this
// is the same arrangement as blocks and wires. Two uses:
//
//   * A starting point. Opening the playground from a demodulator the operator
//     already has tuned gives them that demodulator to take apart, rather than
//     an empty page.
//   * Proof. test/playground.test.js runs these graphs against DemodChain on
//     the same input and requires identical output, sample for sample — which
//     is what says the blocks, the graph and the runtime are right before any
//     interface exists.
//
// The shape, for every mode but SAM and ECSS:
//
//   iq ─► [decimate] ─► shift ─► lowpass ─┬─► detector ─► dc ─► [deemph] ─► agc ─► gain ─┬─► meter
//                                          │                                              └─► gate ×─► clip ─┬─► audio
//                                          └─► power ─► level ─► squelch ─────────────────────────┘          └─► spectrum
//
// and SAM and ECSS replace shift, lowpass, detector and power with the carrier
// tracker, whose carrier output the AGC levels against.
//
// The decimator is there only where the chain has one — a stream wider than
// 12 kHz — which is what keeps the graph the chain, sample for sample. Asked
// for `adaptive`, it is always there, on Auto, so the graph follows the IQ
// width: built on one, it works on any. That is the graph somebody is given
// to keep. Off plain IQ it is still the chain's own, as Auto picks the factor
// the chain does; on plain IQ it mixes the centre down where the chain's shift
// or tracker would, so it agrees with the chain to within the rounding of a
// different oscillator rather than bit for bit. Mixing without filtering moves
// the stream's edges, which the carrier tracker keeps its filters clear of, so
// the decimator's `middle` output is wired to tell it where they went — and its
// `centre`, what the tracker's frequencies are measured from.

import { decimationFor, frontPassFor } from '../lib/iqDemod.js';
import { GRAPH_VERSION } from './graph.js';
import { controlPort } from './block.js';

const SQUELCH_OFF = -60;

/**
 * The graph for one plan (planFor's output) at one stream rate, with the panel's
 * per-demodulator back end: `agc`, `gain`, `squelchDb` and `lockMute` as
 * DemodChain.process takes them, and `adaptive` for a graph that follows the
 * stream's width (above).
 */
export function graphForPlan(plan, rateHz, { agc = true, gain = 1, squelchDb = SQUELCH_OFF, lockMute = false, adaptive = false } = {}) {
    const nodes = [];
    const wires = [];
    let col = 0;
    const add = (id, type, params = {}, row = 0) => {
        nodes.push({ id, type, params, x: col * 180, y: row * 120 });
        return id;
    };
    const wire = (from, fromPort, to, toPort) => wires.push([from, fromPort, to, toPort]);

    const rate = rateHz > 0 ? rateHz : 12000;
    const D = decimationFor(rate, plan);
    const front = adaptive || D > 1;
    const baseHz = front ? plan.centreHz : 0;
    const tracked = plan.kind === 'sam' || plan.kind === 'ecss';

    let at = add('iq', 'iq-in');
    col++;
    if (front) {
        at = add('decimate', 'decimate', { auto: adaptive, factor: D, frequencyHz: baseHz, passHz: frontPassFor(plan) });
        wire('iq', 'out', 'decimate', 'in');
        col++;
    }

    let audio;
    let power;
    let carrier = null;
    if (tracked) {
        add('tracker', 'carrier-tracker', {
            mode: plan.kind,
            centreHz: plan.centreHz,
            baseHz,
            widthHz: plan.widthHz,
            sideband: plan.sideband || 'both',
            trackHz: plan.trackHz,
            lockMute,
        });
        wire(at, 'out', 'tracker', 'in');
        // The decimator tells the tracker what it mixed from, so moving its
        // Centre moves the tracker's with it; and, as on Auto the factor can
        // come to 1, where it only mixes and the stream's edges move, where
        // they went.
        if (adaptive) {
            nodes[nodes.length - 1].controls = ['baseHz', 'middleHz'];
            wire('decimate', 'centre', 'tracker', controlPort('baseHz'));
            wire('decimate', 'middle', 'tracker', controlPort('middleHz'));
        }
        col++;
        audio = ['tracker', 'audio'];
        power = ['tracker', 'power'];
        carrier = ['tracker', 'carrier'];
    } else {
        add('shift', 'shift', { frequencyHz: -(plan.centreHz - baseHz) });
        wire(at, 'out', 'shift', 'in');
        col++;
        add('filter', 'lowpass', { cutoffHz: plan.cutoffHz, transitionHz: plan.transitionHz || 0 });
        wire('shift', 'out', 'filter', 'in');
        col++;
        if (plan.kind === 'ssb') add('detect', 'to-audio', { frequencyHz: plan.shiftHz });
        else if (plan.kind === 'am') add('detect', 'envelope');
        else add('detect', 'fm-discriminator', { deviationHz: plan.cutoffHz });
        wire('filter', 'out', 'detect', 'in');
        add('power', 'power', {}, 1);
        wire('filter', 'out', 'power', 'in');
        col++;
        audio = ['detect', 'out'];
        power = ['power', 'out'];
    }

    add('dc', 'dc-block');
    wire(...audio, 'dc', 'in');
    add('level', 'level-detector', {}, 1);
    wire(...power, 'level', 'in');
    col++;
    let into = ['dc', 'out'];
    if (plan.kind === 'fm') {
        add('deemphasis', 'deemphasis');
        wire('dc', 'out', 'deemphasis', 'in');
        into = ['deemphasis', 'out'];
    }
    add('squelch', 'squelch', { enabled: squelchDb > SQUELCH_OFF, thresholdDb: squelchDb }, 1);
    wire('level', 'out', 'squelch', 'in');
    col++;
    add('agc', 'agc', { apply: agc });
    wire(...into, 'agc', 'in');
    if (carrier) wire(...carrier, 'agc', 'ref');
    col++;
    add('gain', 'gain', { gain });
    wire('agc', 'out', 'gain', 'in');
    add('meter', 'meter', {}, -1);
    wire('gain', 'out', 'meter', 'in');
    col++;
    add('gate', 'multiply');
    wire('gain', 'out', 'gate', 'a');
    wire('squelch', 'out', 'gate', 'b');
    col++;
    let gated = ['gate', 'out'];
    if (tracked && lockMute) {
        // Silent until the tracker locks: after the squelch, as the chain
        // does it.
        add('mute', 'multiply');
        wire('gate', 'out', 'mute', 'a');
        wire('tracker', 'lock', 'mute', 'b');
        gated = ['mute', 'out'];
        col++;
    }
    add('clip', 'clip');
    wire(...gated, 'clip', 'in');
    col++;
    add('audio', 'audio-out');
    wire('clip', 'out', 'audio', 'in');
    add('spectrum', 'audio-spectrum', {}, 1);
    wire('clip', 'out', 'spectrum', 'in');

    return { v: GRAPH_VERSION, nodes, wires };
}
