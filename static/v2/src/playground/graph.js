// A playground graph: what it is, how it is stored, and whether it can run.
//
// ── The stored form ──────────────────────────────────────────────────────────
//
//   {
//     v: 1,
//     name: 'Voice filter',                        what the operator called the
//                                                  graph, where they did — the
//                                                  name it is saved under in
//                                                  this browser (library.js),
//                                                  and what a file or a link
//                                                  carries it as
//     ubersdr: '1.2.3',                            the UberSDR it was made on,
//                                                  where known (version.js) —
//                                                  read, never required
//     nodes: [{ id: 'n1', type: 'lowpass', params: { cutoffHz: 1350 }, x: 120, y: 40 }],
//                                                  `controls: ['cutoffHz']` exposes
//                                                  parameters as control inputs;
//                                                  `name: 'Voice filter'` is what
//                                                  the operator called it, where
//                                                  they did; `w`, `h` the size
//                                                  they gave its card, where
//                                                  they did — older code leaves
//                                                  them out and shows it at its
//                                                  natural size
//     wires: [['n1', 'out', 'n2', 'in']],          from node, port, to node, port
//   }
//
// Small on purpose, because graphs are shared as links: a wire is four short
// strings, and parameters left at their default can be left out entirely —
// parseGraph fills them back in. `v` is the format's version. A graph from a
// newer version than this code knows is refused rather than half-read, and
// any change to the format that an older graph would read differently has to
// move it on.
//
// ── Running ─────────────────────────────────────────────────────────────────
//
// compile() decides whether a graph can run and, if it can, the order to run it
// in and the rate every block works at. The rules are the ones that make the
// runtime simple and the results unsurprising:
//
//   * every wire joins an output to an input of the same kind
//   * an input takes at most one wire, and a required one exactly one
//   * no loops of samples — feedback lives inside blocks, as it does in GNU
//     Radio, or goes through a control (a frequency lock), which is read a
//     packet late
//   * every input of a block arrives at the same rate
//
// Sources run at the stream's rate, and a block's output rate follows from its
// input's through the block's own rule — a decimator divides it.

import { BLOCK_BY_TYPE } from './blocks/index.js';
import { controllable, inputsOf, isStream, outputsOf, sanitizeParams } from './block.js';
import { uberSDRVersion } from './version.js';

export const GRAPH_VERSION = 1;

/** A graph with nothing in it. */
export function emptyGraph() {
    return { v: GRAPH_VERSION, nodes: [], wires: [] };
}

const isName = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64;

// The longest name a block can be given.
export const NAME_MAX = 60;

/**
 * A graph's name as given, made fit to keep: on one line, trimmed, and no
 * longer than NAME_MAX — or '' for none.
 */
export function cleanGraphName(name) {
    if (typeof name !== 'string') return '';
    return name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
}

/**
 * A block's name as given, made fit to keep: on one line, trimmed, and no
 * longer than NAME_MAX — or '' for none, which is also what a name that only
 * repeats the block's own label comes to, so that a block not renamed keeps
 * following its type's label.
 */
export function cleanName(name, type) {
    if (typeof name !== 'string') return '';
    const t = name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
    const def = BLOCK_BY_TYPE[type];
    return def && t === def.label ? '' : t;
}

/** What a block is called: its name, or its type's label where it has none. */
export function nodeName(node) {
    const def = node && BLOCK_BY_TYPE[node.type];
    return (node && node.name) || (def ? def.label : '');
}

/**
 * Read a stored or shared graph. Returns `{ graph, errors, ubersdr }`: the
 * graph as far as it could be read, what had to be left out, and the UberSDR
 * version it was made on ('' where it does not say). Nothing here throws —
 * whatever arrives in a link has to be survivable.
 *
 * `local` is for this browser's own storage and the editor's own graphs, and
 * is the one way `savedAs` survives the read — see below.
 */
export function parseGraph(raw, { local = false } = {}) {
    const errors = [];
    if (!raw || typeof raw !== 'object') {
        return { graph: emptyGraph(), errors: [{ message: 'Not a graph.' }], ubersdr: '' };
    }
    const made = typeof raw.ubersdr === 'string' ? raw.ubersdr.trim().slice(0, 40) : '';
    if (raw.v !== GRAPH_VERSION) {
        const newer = Number(raw.v) > GRAPH_VERSION;
        return {
            graph: emptyGraph(),
            errors: [{
                message: newer
                    ? `This graph was made by a newer version of the playground${made ? `, on UberSDR v${made}` : ''}.`
                    : 'Not a graph this playground can read.',
            }],
            ubersdr: made,
        };
    }
    const nodes = [];
    const ids = new Set();
    for (const n of Array.isArray(raw.nodes) ? raw.nodes : []) {
        if (!n || !isName(n.id) || ids.has(n.id)) {
            errors.push({ message: 'A block without a usable id was left out.' });
            continue;
        }
        const type = BLOCK_BY_TYPE[n.type];
        if (!type) {
            errors.push({ node: n.id, message: `Unknown block “${String(n.type).slice(0, 40)}” was left out.` });
            continue;
        }
        ids.add(n.id);
        const controls = Array.isArray(n.controls)
            ? [...new Set(n.controls.filter((c) => typeof c === 'string' && controllable(type.params[c])))]
            : [];
        const name = cleanName(n.name, n.type);
        // A card's size, where it was given one (geometry.js clamps it to
        // what a card may be when it draws it).
        const size = {};
        if (!type.annotation) {
            for (const k of ['w', 'h']) {
                const v = Number(n[k]);
                if (n[k] != null && Number.isFinite(v) && v > 0) size[k] = Math.round(Math.min(v, 10000));
            }
        }
        nodes.push({
            id: n.id,
            type: n.type,
            ...(name ? { name } : {}),
            params: sanitizeParams(type, n.params),
            ...(controls.length ? { controls } : {}),
            x: Number.isFinite(Number(n.x)) ? Number(n.x) : 0,
            y: Number.isFinite(Number(n.y)) ? Number(n.y) : 0,
            ...size,
        });
    }
    const wires = [];
    for (const w of Array.isArray(raw.wires) ? raw.wires : []) {
        if (!Array.isArray(w) || w.length !== 4 || !w.every(isName)) {
            errors.push({ message: 'A malformed wire was left out.' });
            continue;
        }
        if (!ids.has(w[0]) || !ids.has(w[2])) {
            errors.push({ message: 'A wire to a missing block was left out.' });
            continue;
        }
        wires.push([w[0], w[1], w[2], w[3]]);
    }
    const graphName = cleanGraphName(raw.name);
    const graph = { v: GRAPH_VERSION, ...(graphName ? { name: graphName } : {}), nodes, wires };
    // Which saved graph this one is the working copy of (library.js). Only ever
    // from this browser's own storage — `local` — and never from a file or a
    // link: a link that could claim to be the operator's "Voice filter" would
    // be a link that Save then writes over it with, unasked.
    if (local && typeof raw.savedAs === 'string' && cleanGraphName(raw.savedAs)) graph.savedAs = cleanGraphName(raw.savedAs);
    return { graph, errors, ubersdr: made };
}

/**
 * The stored form of a graph, with every parameter at its default left out.
 * parseGraph(JSON.parse(JSON.stringify(serializeGraph(g)))) gives back g.
 */
export function serializeGraph(graph) {
    const made = uberSDRVersion();
    return {
        v: GRAPH_VERSION,
        // Which UberSDR this was made on, where the page knows.
        ...(made ? { ubersdr: made } : {}),
        ...(cleanGraphName(graph.name) ? { name: cleanGraphName(graph.name) } : {}),
        nodes: graph.nodes.map((n) => {
            const type = BLOCK_BY_TYPE[n.type];
            const params = {};
            for (const [name, value] of Object.entries(n.params || {})) {
                const spec = type && type.params[name];
                if (!spec || value !== spec.default) params[name] = value;
            }
            const out = { id: n.id, type: n.type };
            if (n.name) out.name = n.name;
            if (Object.keys(params).length) out.params = params;
            if (n.controls && n.controls.length) out.controls = [...n.controls];
            // Always, zero included: where a block sits is part of the graph,
            // and a file with half its blocks missing a coordinate reads as
            // one that lost them.
            out.x = Math.round(n.x || 0);
            out.y = Math.round(n.y || 0);
            // Only where the card was resized.
            if (n.w) out.w = Math.round(n.w);
            if (n.h) out.h = Math.round(n.h);
            return out;
        }),
        wires: graph.wires.map((w) => [...w]),
    };
}

/**
 * Whether a graph can run at `streamRate`, and how.
 *
 * Returns `{ ok, errors, order, inputs, inRate, outRate }`:
 *   order    node ids, each after everything feeding it
 *   inputs   per node id, per input port in declaration order, the
 *            [fromId, fromPort] feeding it or null
 *   ports    per node id, its input ports — its type's and its exposed
 *            controls' — in that same order
 *   inRate   per node id, the rate arriving at its inputs
 *   outRate  per node id, the rate it puts out
 *
 * Errors name the node, and the wire where there is one, so the editor can
 * point at the problem rather than describe it.
 */
export function compile(graph, streamRate) {
    const errors = [];
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const inputs = {};
    const ports = {};
    // Two sets of edges: every wire, and the stream wires alone. Control and
    // message wires may close a loop; stream wires may not.
    const next = new Map(graph.nodes.map((n) => [n.id, []]));
    const nextStream = new Map(graph.nodes.map((n) => [n.id, []]));

    for (const n of graph.nodes) {
        const type = BLOCK_BY_TYPE[n.type];
        if (!type) {
            errors.push({ node: n.id, message: `Unknown block “${n.type}”.` });
            continue;
        }
        ports[n.id] = inputsOf(n, type);
        inputs[n.id] = ports[n.id].map(() => null);
    }

    for (const w of graph.wires) {
        const [fromId, fromPort, toId, toPort] = w;
        const from = byId.get(fromId);
        const to = byId.get(toId);
        if (!from || !to || !inputs[toId] || !BLOCK_BY_TYPE[from.type]) {
            errors.push({ wire: w, message: 'A wire joins a block that is not there.' });
            continue;
        }
        const out = outputsOf(from, BLOCK_BY_TYPE[from.type]).find((p) => p.name === fromPort);
        const inIndex = ports[toId].findIndex((p) => p.name === toPort);
        const inp = ports[toId][inIndex];
        if (!out) {
            errors.push({ node: fromId, wire: w, message: `No output “${fromPort}”.` });
            continue;
        }
        if (!inp) {
            errors.push({ node: toId, wire: w, message: `No input “${toPort}”.` });
            continue;
        }
        if (out.kind !== inp.kind) {
            errors.push({ node: toId, wire: w, message: `A ${out.kind} output cannot feed a ${inp.kind} input.` });
            continue;
        }
        if (inputs[toId][inIndex]) {
            errors.push({ node: toId, wire: w, message: `Input “${toPort}” already has a wire.` });
            continue;
        }
        inputs[toId][inIndex] = [fromId, fromPort];
        next.get(fromId).push(toId);
        if (isStream(out.kind)) nextStream.get(fromId).push(toId);
    }

    for (const n of graph.nodes) {
        if (!ports[n.id]) continue;
        ports[n.id].forEach((p, i) => {
            if (!p.optional && !inputs[n.id][i]) {
                errors.push({ node: n.id, message: `Input “${p.name}” needs a wire.` });
            }
        });
    }

    // Kahn's algorithm, in the order the nodes are listed where it is free to
    // choose, so the same graph always runs in the same order. First over
    // every wire, so a control is set before what it controls runs; if that
    // finds a loop, again over the stream wires alone — a loop through a
    // control is allowed, and is read a packet late, as a control loop on any
    // instrument is.
    const kahn = (edges) => {
        const pending = new Map(graph.nodes.map((n) => [n.id, 0]));
        for (const list of edges.values()) for (const to of list) pending.set(to, pending.get(to) + 1);
        const order = [];
        const ready = graph.nodes.filter((n) => pending.get(n.id) === 0).map((n) => n.id);
        while (ready.length) {
            const id = ready.shift();
            order.push(id);
            for (const to of edges.get(id)) {
                pending.set(to, pending.get(to) - 1);
                if (pending.get(to) === 0) ready.push(to);
            }
        }
        return order;
    };
    let order = kahn(next);
    if (order.length < graph.nodes.length) order = kahn(nextStream);
    if (order.length < graph.nodes.length) {
        for (const n of graph.nodes) {
            if (!order.includes(n.id)) errors.push({ node: n.id, message: 'Part of a loop. Feedback has to stay inside a block, or go through a control.' });
        }
    }

    const inRate = {};
    const outRate = {};
    for (const id of order) {
        const n = byId.get(id);
        const type = BLOCK_BY_TYPE[n.type];
        if (!type) continue;
        // Only samples have a rate: control and message inputs do not count.
        const feeding = (inputs[id] || [])
            .map((f, i) => (f && isStream(ports[id][i].kind) ? outRate[f[0]] : null))
            .filter((r) => r != null);
        let rate = streamRate;
        if (feeding.length) {
            rate = feeding[0];
            if (feeding.some((r) => r !== rate)) {
                errors.push({ node: id, message: `Inputs arrive at different rates (${[...new Set(feeding)].join(', ')} Hz).` });
            }
        }
        inRate[id] = rate;
        const out = type.rate ? type.rate(rate, n.params) : rate;
        if (!(out > 0) || !Number.isFinite(out)) {
            errors.push({ node: id, message: 'Puts out no usable rate.' });
        }
        outRate[id] = out;
    }

    return { ok: errors.length === 0, errors, order, inputs, ports, inRate, outRate };
}
