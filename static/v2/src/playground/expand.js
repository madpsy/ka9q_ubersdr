// Taking a demodulator block apart: the same receiver, drawn out as blocks.
//
// A Demodulator block is the IQ Demod panel's DemodChain; graphForPlan draws
// that chain as blocks, and the two are held to each other by
// test/playground.test.js. So expanding keeps the sound — the audio after is
// the audio before — and what was one box is now every stage of it, each with
// its own settings and a port to probe. Its decimator is on Auto, as the block
// was in effect, so it keeps working when the IQ width changes.

import { BLOCK_BY_TYPE } from './blocks/index.js';
import { demodPlan } from './blocks/radio.js';
import { graphForPlan } from './fromPlan.js';
import { parseGraph } from './graph.js';
import { autoLayout } from './geometry.js';
import { cloneGraph } from './editing.js';
import { DECODER_INSIDES, insideOutputs } from './blocks/decoders.js';

// What graphForPlan draws around the chain, which the expansion leaves out:
// the stream it starts from, and the sinks it ends in. The block's own wires
// take their places.
const OUTSIDE = new Set(['iq', 'audio', 'meter', 'spectrum']);

/**
 * The graph with demodulator `id` replaced by its blocks, at the rate arriving
 * at it. Returns `{ graph, ids }`, the new blocks' ids, or the graph unchanged
 * if `id` is not a demodulator.
 */
export function expandDemodulator(graph, id, rateHz) {
    const node = graph.nodes.find((n) => n.id === id);
    if (!node || node.type !== 'demodulator') return { graph, ids: [] };
    const p = node.params;
    const plan = demodPlan(p, rateHz);
    const inner = autoLayout(parseGraph(graphForPlan(plan, rateHz, {
        agc: p.agc, gain: p.gain, squelchDb: p.squelchDb, lockMute: p.lockMute, adaptive: true,
    })).graph);

    const g = cloneGraph(graph);
    const taken = new Set(g.nodes.map((n) => n.id));
    const rename = new Map();
    for (const n of inner.nodes) {
        if (OUTSIDE.has(n.id)) continue;
        let name = `${id}_${n.id}`;
        for (let k = 2; taken.has(name); k++) name = `${id}_${n.id}${k}`;
        taken.add(name);
        rename.set(n.id, name);
    }

    // Laid out where the block was, starting from its corner.
    const kept = inner.nodes.filter((n) => rename.has(n.id));
    const x0 = Math.min(...kept.map((n) => n.x));
    const y0 = Math.min(...kept.map((n) => n.y));
    const added = kept.map((n) => ({ ...n, id: rename.get(n.id), x: node.x + n.x - x0, y: node.y + n.y - y0 }));

    // The block's own wires: what fed it, and what it fed.
    const feeding = g.wires.find((w) => w[2] === id && w[3] === 'in');
    const fed = g.wires.filter((w) => w[0] === id);
    const wires = g.wires.filter((w) => w[0] !== id && w[2] !== id);
    for (const w of inner.wires) {
        const [a, ap, b, bp] = w;
        if (rename.has(a) && rename.has(b)) wires.push([rename.get(a), ap, rename.get(b), bp]);
        // Where the inner graph took the stream, the block's own input does.
        else if (a === 'iq' && rename.has(b) && feeding) wires.push([feeding[0], feeding[1], rename.get(b), bp]);
    }
    // The audio leaves from the clip at the end, as the chain's does; the
    // passband level from the level detector, which is what the chain's
    // `signal` reads.
    for (const w of fed) {
        if (w[1] === 'audio' && rename.has('clip')) wires.push([rename.get('clip'), 'out', w[2], w[3]]);
        else if (w[1] === 'signal' && rename.has('level')) wires.push([rename.get('level'), 'db', w[2], w[3]]);
    }
    const nodes = [...g.nodes.filter((n) => n.id !== id), ...added];
    return { graph: { ...g, nodes, wires }, ids: added.map((n) => n.id) };
}

/**
 * The graph with a one-block decoder (RTTY, PSK31, CW, NAVTEX) replaced by the
 * graph it runs inside — the same blocks with the same settings, so the text
 * is the same text. Returns `{ graph, ids }`.
 */
export function expandDecoder(graph, id) {
    const node = graph.nodes.find((n) => n.id === id);
    const inside = node && DECODER_INSIDES[node.type];
    if (!inside) return { graph, ids: [] };
    const d = inside(node.params);
    const laid = autoLayout(parseGraph({ v: graph.v, nodes: d.nodes, wires: d.wires }).graph);
    const g = cloneGraph(graph);
    const taken = new Set(g.nodes.map((n) => n.id));
    const rename = new Map();
    for (const n of laid.nodes) {
        let name = `${id}_${n.id}`;
        for (let k = 2; taken.has(name); k++) name = `${id}_${n.id}${k}`;
        taken.add(name);
        rename.set(n.id, name);
    }
    const added = laid.nodes.map((n) => ({ ...n, id: rename.get(n.id), x: node.x + n.x, y: node.y + n.y }));
    const feeding = g.wires.find((w) => w[2] === id && w[3] === (BLOCK_BY_TYPE[node.type].inputs[0] || {}).name);
    const fed = g.wires.filter((w) => w[0] === id);
    const wires = g.wires.filter((w) => w[0] !== id && w[2] !== id);
    for (const [a, ap, b, bp] of laid.wires) wires.push([rename.get(a), ap, rename.get(b), bp]);
    if (feeding) wires.push([feeding[0], feeding[1], rename.get(d.input[0]), d.input[1]]);
    const outs = insideOutputs(d);
    for (const w of fed) if (outs[w[1]]) wires.push([rename.get(outs[w[1]][0]), outs[w[1]][1], w[2], w[3]]);
    const nodes = [...g.nodes.filter((n) => n.id !== id), ...added];
    return { graph: { ...g, nodes, wires }, ids: added.map((n) => n.id) };
}

/** Whether a node can be expanded. */
export const expandable = (node) => !!node && (node.type === 'demodulator' || !!DECODER_INSIDES[node.type]) && !!BLOCK_BY_TYPE[node.type];

/** Expand whatever kind of expandable block `id` is. */
export function expandNode(graph, id, rateHz) {
    const node = graph.nodes.find((n) => n.id === id);
    if (!node) return { graph, ids: [] };
    return node.type === 'demodulator' ? expandDemodulator(graph, id, rateHz) : expandDecoder(graph, id);
}
