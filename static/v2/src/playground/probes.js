// Probing a graph: hanging an instrument off any port, and knowing what
// frequencies a complex wire carries.
//
// A probe is just a viewer block wired to an output. Viewers are sinks, so the
// wire it hangs from carries on exactly as before — which is why the editor can
// offer one on every port, inputs included: probing an input is probing the
// output that feeds it, so a block's input and its output can be looked at side
// by side.

import { BLOCK_BY_TYPE } from './blocks/index.js';
import { addNode, connectPorts } from './editing.js';
import { nodeHeight, nodeWidth } from './geometry.js';
import { inputsOf, outputsOf } from './block.js';

/** The instruments that can look at each kind of signal, most useful first. */
export const PROBES = {
    complex: [
        { type: 'iq-spectrum', label: 'Spectrum' },
        { type: 'constellation', label: 'Constellation' },
        { type: 'frequency-counter', label: 'Counter' },
        { type: 'signal-detector', label: 'Detector' },
    ],
    real: [
        { type: 'scope', label: 'Scope' },
        { type: 'audio-spectrum', label: 'Spectrum' },
        { type: 'meter', label: 'Meter' },
    ],
    control: [
        { type: 'control-plot', label: 'Plot' },
    ],
    message: [
        { type: 'console', label: 'Console' },
        { type: 'message-log', label: 'Log' },
    ],
    bits: [
        { type: 'bit-view', label: 'Bits' },
    ],
};

/** The kind an output carries, or null. */
export function outputKind(graph, id, port) {
    const n = graph.nodes.find((x) => x.id === id);
    const def = n && BLOCK_BY_TYPE[n.type];
    const p = def && outputsOf(n, def).find((o) => o.name === port);
    return p ? p.kind : null;
}

/**
 * Hang a viewer of `type` off an output. Placed below and to the right of the
 * block it probes, stepped down past any probes already there, so a second
 * probe does not land on the first. `intoPort` picks the viewer's input when
 * it has more than one. Returns `{ graph, id }`.
 */
export function addProbe(graph, fromId, fromPort, type, intoPort = null) {
    const src = graph.nodes.find((n) => n.id === fromId);
    if (!src || !BLOCK_BY_TYPE[type]) return { graph, id: null };
    const isViewer = (id) => {
        const n = graph.nodes.find((x) => x.id === id);
        return !!n && BLOCK_BY_TYPE[n.type] && BLOCK_BY_TYPE[n.type].category === 'Viewers';
    };
    const already = graph.wires.filter((w) => w[0] === fromId && isViewer(w[2]));
    let y = src.y + nodeHeight(src) + 30;
    for (const w of already) {
        const v = graph.nodes.find((n) => n.id === w[2]);
        y = Math.max(y, v.y + nodeHeight(v) + 20);
    }
    const x = src.x + Math.round(nodeWidth(src.type) / 2);
    const r = addNode(graph, type, x, y);
    const def = BLOCK_BY_TYPE[type];
    const kind = outputKind(graph, fromId, fromPort);
    const input = inputsOf({ type }, def).find((p) => p.kind === kind && (!intoPort || p.name === intoPort));
    if (!input) return { graph, id: null };
    return { graph: connectPorts(r.graph, fromId, fromPort, r.id, input.name), id: r.id };
}

/**
 * The frequency on the air that each complex output's zero stands for, or
 * null where it cannot be known.
 *
 * The receiver's stream is centred on the dial, so its zero is the dial; a
 * player's is the centre frequency its file was recorded at, where that is
 * known. A shift by f moves everything up by f, so the zero it puts out stood
 * for f below the one it took in; a decimator brings its centre to zero, so
 * its zero stood for that much above. Filters move nothing. A shift whose
 * frequency a control is driving is moving, so it is not known; nor is
 * anything after a conjugate (which mirrors), a multiply (which mixes two
 * signals) or a generator (which was never on the air) — and an instrument
 * after one labels offsets rather than inventing a frequency.
 *
 * Returns a map of `${id}.${port}` to Hz, or null.
 */
export function frequencyOrigins(graph, dialHz) {
    const out = new Map();
    const into = new Map();
    for (const w of graph.wires) into.set(`${w[2]}.${w[3]}`, `${w[0]}.${w[1]}`);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const PASS = new Set(['lowpass', 'complex-highpass', 'complex-bandpass', 'delay', 'resample']);
    const visiting = new Set();
    const driven = (n, param) => (n.controls || []).includes(param) && into.has(`${n.id}.set:${param}`);
    const originOf = (key) => {
        if (out.has(key)) return out.get(key);
        if (visiting.has(key)) return null;
        visiting.add(key);
        const [id] = key.split('.');
        const n = byId.get(id);
        let o = null;
        if (n) {
            const upstream = () => {
                const from = into.get(`${id}.in`);
                return from ? originOf(from) : null;
            };
            if (n.type === 'iq-in') o = dialHz > 0 ? dialHz : null;
            else if (n.type === 'iq-player') o = n.params.centreHz > 0 ? n.params.centreHz : null;
            else if (n.type === 'shift') {
                const u = upstream();
                o = u == null || driven(n, 'frequencyHz') ? null : u - n.params.frequencyHz;
            } else if (n.type === 'decimate') {
                const u = upstream();
                o = u == null || driven(n, 'frequencyHz') ? null : u + n.params.frequencyHz;
            } else if (PASS.has(n.type)) o = upstream();
        }
        visiting.delete(key);
        out.set(key, o);
        return o;
    };
    for (const n of graph.nodes) {
        const def = BLOCK_BY_TYPE[n.type];
        if (!def) continue;
        for (const p of def.outputs) if (p.kind === 'complex') originOf(`${n.id}.${p.name}`);
    }
    return out;
}

/**
 * The frequency the zero of whatever feeds a node's input stands for, or null.
 * A message log fed by a signal detector takes the detector's, so its events
 * can be named in real frequencies too.
 */
export function inputOrigin(graph, origins, id, port = 'in') {
    const w = graph.wires.find((x) => x[2] === id && x[3] === port);
    if (!w) return null;
    const src = graph.nodes.find((n) => n.id === w[0]);
    if (src && src.type === 'signal-detector' && w[1] === 'events') return inputOrigin(graph, origins, src.id);
    return origins.get(`${w[0]}.${w[1]}`) ?? null;
}

/**
 * The pair of wires to measure a block across: what arrives at an input, and
 * what leaves an output of the same kind. Null when the block has no such
 * pair — a source, a sink, or one that turns complex into real.
 */
export function acrossPair(graph, id) {
    const n = graph.nodes.find((x) => x.id === id);
    const def = n && BLOCK_BY_TYPE[n.type];
    if (!def) return null;
    for (const out of def.outputs) {
        for (const inp of def.inputs) {
            if (inp.kind !== out.kind) continue;
            const w = graph.wires.find((x) => x[2] === id && x[3] === inp.name);
            if (w) return { kind: out.kind, from: [w[0], w[1]], to: [id, out.name] };
        }
    }
    return null;
}

/**
 * Hang a gain-and-phase meter across a block: `a` from what feeds its input,
 * `b` from its output — the block's own response at the frequency going
 * through it. Returns `{ graph, id }`.
 */
export function addAcross(graph, id) {
    const pair = acrossPair(graph, id);
    if (!pair) return { graph, id: null };
    const type = pair.kind === 'complex' ? 'iq-phase-meter' : 'phase-meter';
    const r = addProbe(graph, pair.to[0], pair.to[1], type, 'b');
    if (!r.id) return r;
    return { graph: connectPorts(r.graph, pair.from[0], pair.from[1], r.id, 'a'), id: r.id };
}
