// Changing a graph, as the editor does: pure functions from one graph to the
// next, and the history that undo walks back through.
//
// Nothing here touches the engine or the page. Each edit returns a new graph
// (the old one is left as it was, which is what makes undo a matter of keeping
// the old ones), and refuses quietly — returning the graph unchanged — rather
// than throwing, because every one of them is a gesture and a gesture that
// cannot be done should simply not happen.

import { BLOCK_BY_TYPE } from './blocks/index.js';
import { controlPort, controllable, inputsOf, isStream, outputsOf, sanitizeParams } from './block.js';
import { cleanName } from './graph.js';

/** A copy of a graph that shares nothing with it. */
export const cloneGraph = (g) => ({
    v: g.v,
    nodes: g.nodes.map((n) => ({ ...n, params: { ...n.params }, ...(n.controls ? { controls: [...n.controls] } : {}) })),
    wires: g.wires.map((w) => [...w]),
});

/** An id no node in the graph has: the type's short name and a number. */
export function freshId(graph, type) {
    const base = String(type).replace(/[^a-z0-9]+/gi, '').slice(0, 12) || 'node';
    const taken = new Set(graph.nodes.map((n) => n.id));
    for (let k = 1; ; k++) {
        const id = `${base}${k}`;
        if (!taken.has(id)) return id;
    }
}

/** Add a block of `type` at (x, y). Returns `{ graph, id }`. */
export function addNode(graph, type, x = 0, y = 0, params = {}) {
    const def = BLOCK_BY_TYPE[type];
    if (!def) return { graph, id: null };
    const g = cloneGraph(graph);
    const id = freshId(g, type);
    g.nodes.push({ id, type, params: sanitizeParams(def, params), x: Math.round(x), y: Math.round(y) });
    return { graph: g, id };
}

/**
 * Give block `id` a name — cleaned as a stored one is (graph.js cleanName), so
 * an empty one, or the block's own label, puts it back to its type's label.
 * The graph unchanged if that changes nothing.
 */
export function renameNode(graph, id, name) {
    const n = graph.nodes.find((x) => x.id === id);
    if (!n) return graph;
    const clean = cleanName(name, n.type);
    if (clean === (n.name || '')) return graph;
    const g = cloneGraph(graph);
    const m = g.nodes.find((x) => x.id === id);
    if (clean) m.name = clean;
    else delete m.name;
    return g;
}

/** Remove blocks, and every wire to or from them. */
export function removeNodes(graph, ids) {
    const gone = new Set(ids);
    if (!graph.nodes.some((n) => gone.has(n.id))) return graph;
    const g = cloneGraph(graph);
    g.nodes = g.nodes.filter((n) => !gone.has(n.id));
    g.wires = g.wires.filter((w) => !gone.has(w[0]) && !gone.has(w[2]));
    return g;
}

/**
 * Whether an output can be wired to an input: both exist, are of one kind,
 * and are on different blocks. Says why not, for the editor to show.
 */
export function canConnect(graph, fromId, fromPort, toId, toPort) {
    if (fromId === toId) return { ok: false, why: 'A block cannot feed itself.' };
    const from = graph.nodes.find((n) => n.id === fromId);
    const to = graph.nodes.find((n) => n.id === toId);
    if (!from || !to) return { ok: false, why: 'No such block.' };
    const out = outputsOf(from, BLOCK_BY_TYPE[from.type]).find((p) => p.name === fromPort);
    const inp = inputsOf(to, BLOCK_BY_TYPE[to.type]).find((p) => p.name === toPort);
    if (!out || !inp) return { ok: false, why: 'No such port.' };
    if (out.kind !== inp.kind) return { ok: false, why: `A ${out.kind} output cannot feed a ${inp.kind} input.` };
    // A loop of samples cannot run; a loop through a control is a feedback
    // loop — a frequency lock — and is fine.
    if (isStream(out.kind) && wouldLoop(graph, fromId, toId)) return { ok: false, why: 'That would make a loop. Feedback can go through a control.' };
    return { ok: true, why: null };
}

/** Whether `to` already feeds `from`, so a wire from→to would close a loop. */
function wouldLoop(graph, fromId, toId) {
    const seen = new Set();
    const stack = [toId];
    while (stack.length) {
        const id = stack.pop();
        if (id === fromId) return true;
        if (seen.has(id)) continue;
        seen.add(id);
        for (const w of graph.wires) if (w[0] === id && isStreamWire(graph, w)) stack.push(w[2]);
    }
    return false;
}

/**
 * Wire an output to an input. An input takes one wire, so whatever was on it
 * is replaced — which is what dropping a new wire onto an input means.
 */
export function connectPorts(graph, fromId, fromPort, toId, toPort) {
    if (!canConnect(graph, fromId, fromPort, toId, toPort).ok) return graph;
    const g = cloneGraph(graph);
    g.wires = g.wires.filter((w) => !(w[2] === toId && w[3] === toPort));
    g.wires.push([fromId, fromPort, toId, toPort]);
    return g;
}

/** Whether a wire carries samples. */
function isStreamWire(graph, w) {
    const n = graph.nodes.find((x) => x.id === w[0]);
    const p = n && BLOCK_BY_TYPE[n.type] && outputsOf(n, BLOCK_BY_TYPE[n.type]).find((o) => o.name === w[1]);
    return !!p && isStream(p.kind);
}

/**
 * Give a parameter a control input, or take it away — and with it any wire
 * that was driving it.
 */
export function exposeControl(graph, id, param, on) {
    const n = graph.nodes.find((x) => x.id === id);
    const def = n && BLOCK_BY_TYPE[n.type];
    if (!def || !controllable(def.params[param])) return graph;
    const has = (n.controls || []).includes(param);
    if (has === !!on) return graph;
    const g = cloneGraph(graph);
    const m = g.nodes.find((x) => x.id === id);
    if (on) {
        m.controls = [...(m.controls || []), param];
    } else {
        m.controls = m.controls.filter((c) => c !== param);
        if (!m.controls.length) delete m.controls;
        g.wires = g.wires.filter((w) => !(w[2] === id && w[3] === controlPort(param)));
    }
    return g;
}

/** Remove the wire into an input, if there is one. */
export function disconnectInput(graph, toId, toPort) {
    if (!graph.wires.some((w) => w[2] === toId && w[3] === toPort)) return graph;
    const g = cloneGraph(graph);
    g.wires = g.wires.filter((w) => !(w[2] === toId && w[3] === toPort));
    return g;
}

/** Remove one wire by its position in the list. */
export function removeWire(graph, index) {
    if (!graph.wires[index]) return graph;
    const g = cloneGraph(graph);
    g.wires.splice(index, 1);
    return g;
}

/** Move blocks by (dx, dy). */
export function moveNodes(graph, ids, dx, dy) {
    const set = new Set(ids);
    const g = cloneGraph(graph);
    for (const n of g.nodes) {
        if (set.has(n.id)) {
            n.x = Math.round(n.x + dx);
            n.y = Math.round(n.y + dy);
        }
    }
    return g;
}

/**
 * Copies of blocks, offset, with the wires between them — not the wires in
 * from outside, which would steal those inputs from the originals' sources.
 * Returns `{ graph, ids }`, the copies' ids.
 */
export function duplicateNodes(graph, ids, offset = 40) {
    const set = new Set(ids);
    let g = cloneGraph(graph);
    const map = new Map();
    for (const n of graph.nodes) {
        if (!set.has(n.id)) continue;
        const r = addNode(g, n.type, n.x + offset, n.y + offset, n.params);
        g = r.graph;
        const copy = g.nodes.find((x) => x.id === r.id);
        if (n.controls) copy.controls = [...n.controls];
        if (n.name) copy.name = n.name;
        if (n.w) copy.w = n.w;
        if (n.h) copy.h = n.h;
        map.set(n.id, r.id);
    }
    for (const w of graph.wires) {
        if (map.has(w[0]) && map.has(w[2])) g.wires.push([map.get(w[0]), w[1], map.get(w[2]), w[3]]);
    }
    return { graph: g, ids: [...map.values()] };
}

// ── history ──────────────────────────────────────────────────────────────────

const HISTORY_LIMIT = 100;
// Edits under one key within this long are one step: a slider dragged through
// a hundred values is undone in one press, not a hundred.
const COALESCE_MS = 1000;

/**
 * Undo and redo over whole graphs. A graph is a few kilobytes and the limit is
 * a hundred steps, so keeping copies is simpler than keeping inverses and costs
 * nothing worth counting.
 */
export class EditHistory {
    constructor(graph, now = () => Date.now()) {
        this.past = [];
        this.future = [];
        this.current = graph;
        this._now = now;
        this._key = null;
        this._at = 0;
    }

    /**
     * Record `next` as the current graph. With a `key`, a second record under
     * the same key soon after the first replaces it instead of adding a step.
     */
    push(next, key = null) {
        if (next === this.current) return;
        const t = this._now();
        const merge = key !== null && key === this._key && t - this._at < COALESCE_MS;
        if (!merge) {
            this.past.push(this.current);
            if (this.past.length > HISTORY_LIMIT) this.past.shift();
        }
        this.current = next;
        this.future = [];
        this._key = key;
        this._at = t;
    }

    get canUndo() { return this.past.length > 0; }

    get canRedo() { return this.future.length > 0; }

    undo() {
        if (!this.past.length) return this.current;
        this.future.push(this.current);
        this.current = this.past.pop();
        this._key = null;
        return this.current;
    }

    redo() {
        if (!this.future.length) return this.current;
        this.past.push(this.current);
        this.current = this.future.pop();
        this._key = null;
        return this.current;
    }

    /** Start again from `graph`, keeping where we came from as one undo step. */
    replace(graph) {
        this.push(graph);
        this._key = null;
    }
}
