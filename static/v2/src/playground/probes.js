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
import { cardWidth, nodeHeight } from './geometry.js';
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
        { type: 'strip-chart', label: 'Strip chart' },
        { type: 'audio-spectrum', label: 'Spectrum' },
        { type: 'meter', label: 'Meter' },
        { type: 'histogram', label: 'Histogram' },
        { type: 'readout', label: 'Readout' },
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
    const x = src.x + Math.round(cardWidth(src) / 2);
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
 * known, and a generator's the one it was given, if any. A shift by f moves
 * everything up by f, so the zero it puts out stood for f below the one it
 * took in; a decimator brings its centre to zero, so its zero stood for that
 * much above. Filters move nothing. A shift whose frequency a control is
 * driving is moving, so it is not known; nor is anything after a conjugate
 * (which mirrors), a multiply (which mixes two signals) or a generator given
 * no centre (which was never on the air) — and an instrument after one labels
 * offsets rather than inventing a frequency.
 *
 * Given `driven` — the values controls have set, by node, from the engine —
 * a driven shift is known after all: wherever it is right now.
 *
 * Returns a map of `${id}.${port}` to Hz, or null.
 */
export function frequencyOrigins(graph, dialHz, driven = null) {
    const out = new Map();
    const into = new Map();
    for (const w of graph.wires) into.set(`${w[2]}.${w[3]}`, `${w[0]}.${w[1]}`);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const PASS = new Set(['lowpass', 'complex-highpass', 'complex-bandpass', 'delay', 'resample']);
    const visiting = new Set();
    const isDriven = (n, param) => (n.controls || []).includes(param) && into.has(`${n.id}.set:${param}`);
    // A driven setting's value now, or null where it is driven and not known.
    const setting = (n, param) => {
        if (!isDriven(n, param)) return n.params[param];
        const v = driven && driven[n.id] ? driven[n.id][param] : undefined;
        return Number.isFinite(v) ? v : null;
    };
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
            else if (n.type === 'iq-player' || n.type === 'signal' || n.type === 'data-tx') o = n.params.centreHz > 0 ? n.params.centreHz : null;
            else if (n.type === 'shift') {
                const u = upstream();
                const f = setting(n, 'frequencyHz');
                o = u == null || f == null ? null : u - f;
            } else if (n.type === 'decimate') {
                const u = upstream();
                const f = setting(n, 'frequencyHz');
                o = u == null || f == null ? null : u + f;
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
 * The stretch of the air a complex stream covers: `rateHz` wide, centred on
 * its zero. In MHz to the kHz above 1 MHz, in kHz to the 100 Hz below — the
 * span runs to tens of kHz, so finer would only be noise on the card. Null
 * when the zero is not known.
 */
export function airSpan(zeroHz, rateHz) {
    if (!(zeroHz > 0)) return null;
    const mhz = zeroHz + (rateHz > 0 ? rateHz / 2 : 0) >= 1e6;
    const name = (hz) => (mhz ? (hz / 1e6).toFixed(3) : (hz / 1e3).toFixed(1));
    const unit = mhz ? 'MHz' : 'kHz';
    const centre = mhz ? `${(zeroHz / 1e6).toFixed(6)} MHz` : `${(zeroHz / 1e3).toFixed(3)} kHz`;
    if (!(rateHz > 0)) return { lo: zeroHz, hi: zeroHz, range: centre, centre, width: '' };
    const lo = zeroHz - rateHz / 2;
    const hi = zeroHz + rateHz / 2;
    const width = `${Number((rateHz / 1000).toFixed(rateHz % 1000 ? 2 : 0))} kHz wide`;
    return { lo, hi, range: `${name(lo)}–${name(hi)} ${unit}`, centre, width };
}

/** Where a source block's output is centred on the air, or null. */
export function sourceZero(node, dialHz) {
    if (!node) return null;
    if (node.type === 'iq-in') return dialHz > 0 ? dialHz : null;
    if (node.type === 'iq-player' || node.type === 'signal' || node.type === 'data-tx') return node.params.centreHz > 0 ? node.params.centreHz : null;
    return null;
}

/** The source at the head of the stream reaching a node, following its first complex input up. */
export function sourceOf(graph, id) {
    const seen = new Set();
    let at = graph.nodes.find((n) => n.id === id);
    while (at && !seen.has(at.id)) {
        seen.add(at.id);
        const def = BLOCK_BY_TYPE[at.type];
        const port = def && def.inputs.find((p) => p.kind === 'complex');
        if (!port) return at;
        const w = graph.wires.find((x) => x[2] === at.id && x[3] === port.name);
        if (!w) return null;
        at = graph.nodes.find((n) => n.id === w[0]);
    }
    return null;
}

// Blocks that listen somewhere in their input rather than at its zero.
const TUNED = new Set([
    'demodulator', 'rtty-decoder', 'psk31-decoder', 'cw-decoder', 'navtex-decoder', 'olivia-decoder', 'mfsk-decoder', 'dominoex-decoder', 'thor-decoder',
]);

/**
 * Where on the air a block is working, and how far that is from the centre
 * of the source it hangs from. For a block that puts out a complex stream, the
 * frequency its output's zero stands for; for one that listens at an offset in
 * its input — a demodulator, a decoder — the frequency it listens at,
 * following an auto-tuning decoder to wherever it has pulled itself. `live`
 * is `{ driven, reading }` from the engine, for whatever controls are moving.
 *
 * Returns `{ hz, shiftHz, listening, live }` — `hz` null where it is not
 * known (after a generator with no centre, a mirror, a mix, or a control not
 * yet heard from), `live` whether it can change while running — or null for a block
 * that takes no complex stream.
 */
export function rfOf(graph, node, dialHz, origins = null, live = null) {
    const def = node && BLOCK_BY_TYPE[node.type];
    if (!def || !def.inputs.some((p) => p.kind === 'complex')) return null;
    const anyDriven = graph.nodes.some((n) => (n.controls || []).includes('frequencyHz') && graph.wires.some((w) => w[2] === n.id && w[3] === `set:frequencyHz`));
    const map = live && anyDriven ? frequencyOrigins(graph, dialHz, live.driven) : origins || frequencyOrigins(graph, dialHz);
    const out = def.outputs.find((p) => p.kind === 'complex');
    const listening = TUNED.has(node.type);
    let hz = null;
    if (out && !listening) hz = map.get(`${node.id}.${out.name}`) ?? null;
    else {
        const base = inputOrigin(graph, map, node.id);
        if (base != null) {
            const tuned = live && live.reading && Number.isFinite(live.reading.tunedHz) ? live.reading.tunedHz : null;
            hz = base + (listening ? (tuned ?? node.params.offsetHz ?? 0) : 0);
        }
    }
    const src = sourceOf(graph, node.id);
    const centre = sourceZero(src, dialHz);
    return {
        hz,
        shiftHz: hz != null && centre != null ? hz - centre : null,
        listening,
        live: anyDriven || (node.type === 'psk31-decoder' && !!node.params.afc),
    };
}

/** A frequency on the air, to the hertz, grouped in threes: "14.073 000 MHz". */
export function rfLabel(hz) {
    if (hz == null || !Number.isFinite(hz)) return '';
    const group = (s) => s.replace(/(\d{3})(?=\d)/g, '$1 ');
    if (Math.abs(hz) >= 1e6) {
        const [a, b] = (hz / 1e6).toFixed(6).split('.');
        return `${a}.${group(b)} MHz`;
    }
    return `${(hz / 1e3).toFixed(3)} kHz`;
}

/** An offset from the centre, signed: "−1 000 Hz", "+12.5 kHz". */
export function shiftLabel(hz) {
    if (hz == null || !Number.isFinite(hz)) return '';
    const r = Math.round(hz);
    const sign = r > 0 ? '+' : r < 0 ? '−' : '±';
    const a = Math.abs(r);
    if (a >= 100000) return `${sign}${Number((a / 1000).toFixed(1))} kHz`;
    return `${sign}${String(a).replace(/\B(?=(\d{3})+$)/g, ' ')} Hz`;
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
