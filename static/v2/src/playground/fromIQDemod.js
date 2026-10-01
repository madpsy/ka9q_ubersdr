// IQ Demod's demodulators as playground graphs: one of them, or all of them.
//
// Each demodulator is graphForPlan's chain for its plan, adaptive so it
// follows the IQ width, with the panel's own output settings carried over —
// the device it plays on, its pan as the Audio out's channel, whether it is
// muted. With several, they share one IQ stream, each in a row of its own
// inside a titled group, the way the panel lists them.

import { DEMOD_MODES, VFO_LABELS, demodSettings, planForVfo, vfoWidth } from '../lib/iqDemod.js';
import { graphForPlan } from './fromPlan.js';
import { GRAPH_VERSION, parseGraph } from './graph.js';
import { autoLayout, nodeBox } from './geometry.js';

const modeLabel = (id) => (DEMOD_MODES.find((m) => m.id === id) || { label: String(id).toUpperCase() }).label;

const khz = (hz) => `${Number((hz / 1000).toFixed(hz % 100 ? 2 : 1))} kHz`;

/** A signed offset as it reads on the panel: "+1.5 kHz", "−700 Hz", "0 Hz". */
function offsetLabel(hz) {
    const r = Math.round(hz || 0);
    if (!r) return '0 Hz';
    const sign = r > 0 ? '+' : '−';
    const a = Math.abs(r);
    return `${sign}${a >= 1000 ? khz(a) : `${a} Hz`}`;
}

/** What a demodulator is, in a line: its number, mode, width and offset. */
export function channelSummary(vfo, index) {
    return `${VFO_LABELS[index] || index + 1} · ${modeLabel(vfo.mode)} · ${khz(vfoWidth(vfo))} · ${offsetLabel(vfo.offsetHz)}`;
}

/** The panel's demodulators, and which one is selected. */
export function iqDemodChannels() {
    const s = demodSettings();
    return { vfos: s.vfos, active: Math.min(Math.max(0, s.active || 0), s.vfos.length - 1) };
}

/** One demodulator's chain, not yet laid out, with its output settings carried over. */
function chainFor(vfo, rate) {
    const g = parseGraph(graphForPlan(planForVfo(vfo), rate, {
        agc: vfo.agc, gain: vfo.gain, squelchDb: vfo.squelchDb, lockMute: vfo.lockMute, adaptive: true,
    })).graph;
    const out = g.nodes.find((n) => n.id === 'audio');
    if (out) {
        out.params = {
            ...out.params,
            device: vfo.sinkId || '',
            channel: vfo.pan === 'left' ? 'left' : vfo.pan === 'right' ? 'right' : 'both',
            muted: !!vfo.muted,
        };
    }
    return g;
}

/**
 * One of IQ Demod's demodulators as a graph — `index`, or the selected one —
 * its output settings carried over.
 */
export function graphFromIQDemod(rate, index = null) {
    const { vfos, active } = iqDemodChannels();
    const vfo = vfos[index ?? active] || vfos[0];
    return autoLayout(chainFor(vfo, rate));
}

// Around each channel's row: room inside its group, the group's title bar, and
// the gap down to the next.
const GROUP_PAD = 24;
const GROUP_TITLE = 30;
const ROW_GAP = 40;
// From the shared IQ stream across to where the rows begin.
const STREAM_GAP = 80;

/**
 * Every one of IQ Demod's demodulators, as one graph: a single IQ stream
 * feeding each one's chain, a row apiece, each row in a group titled with the
 * channel and its Audio out named after it. Ids are the chain's own with the
 * channel's number in front — `c2_tracker` — so every one can be told apart.
 */
export function graphFromAllChannels(rate) {
    const { vfos } = iqDemodChannels();
    const nodes = [];
    const wires = [];
    const groups = [];
    let y = 0;
    let streamRight = 0;
    vfos.forEach((vfo, i) => {
        const prefix = `c${VFO_LABELS[i] || i + 1}_`;
        const chain = autoLayout(chainFor(vfo, rate));
        const iq = chain.nodes.find((n) => n.id === 'iq');
        streamRight = Math.max(streamRight, iq ? nodeBox(iq).w : 0);
        const own = chain.nodes.filter((n) => n.id !== 'iq');
        // The row's own box, from its leftmost and topmost card, so the
        // chain's layout is kept and only moved.
        const x0 = Math.min(...own.map((n) => n.x));
        const y0 = Math.min(...own.map((n) => n.y));
        const right = Math.max(...own.map((n) => nodeBox(n).x + nodeBox(n).w));
        const bottom = Math.max(...own.map((n) => nodeBox(n).y + nodeBox(n).h));
        const top = y + GROUP_TITLE + GROUP_PAD;
        groups.push({ i, vfo, x0, w: right - x0, y, h: bottom - y0 + GROUP_TITLE + GROUP_PAD * 2 });
        for (const n of own) {
            nodes.push({
                ...n,
                id: prefix + n.id,
                // Placed once the stream's width is known: for now, relative.
                x: n.x - x0,
                y: n.y - y0 + top,
                ...(n.id === 'audio' ? { name: `Channel ${VFO_LABELS[i] || i + 1} audio` } : {}),
            });
        }
        for (const w of chain.wires) {
            wires.push([w[0] === 'iq' ? 'iq' : prefix + w[0], w[1], prefix + w[2], w[3]]);
        }
        y += groups[groups.length - 1].h + ROW_GAP;
    });
    // Every row starts the same distance right of the stream, inside its group.
    const left = streamRight + STREAM_GAP + GROUP_PAD;
    for (const n of nodes) n.x += left;
    const total = y - ROW_GAP;
    const out = [
        { id: 'iq', type: 'iq-in', params: {}, x: 0, y: Math.max(0, Math.round(total / 2 - 40)) },
        ...groups.map((gr) => ({
            id: `c${VFO_LABELS[gr.i] || gr.i + 1}_group`,
            type: 'group',
            params: { title: `Channel ${channelSummary(gr.vfo, gr.i)}`, colour: 'blue', w: Math.round(gr.w + GROUP_PAD * 2), h: Math.round(gr.h) },
            x: left - GROUP_PAD,
            y: gr.y,
        })),
        ...nodes,
    ];
    return parseGraph({ v: GRAPH_VERSION, nodes: out, wires }).graph;
}
