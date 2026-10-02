// Running a playground graph, one packet of the stream at a time.
//
// Plain JavaScript with no DOM in it, so it runs the same in a worker, in the
// page or under node — the tests drive it exactly as the browser will.
//
// Each packet goes through every block once, in the order compile() fixed.
// Each output port owns a buffer that every block wired to it reads. Nothing
// writes to an input, which is why the in-place stages in lib/dsp/ copy to
// their output first (see blocks/levels.js), and why one output can feed any
// number of blocks for free.
//
// A block with several inputs needs them aligned, and they need not arrive in
// step: two paths through different decimators reach the same rate but can
// hand over different numbers of samples in one packet. So such a block reads
// through a queue per input and takes as many frames as all of them have,
// leaving the rest for the next packet. A block with one input never waits.
//
// A graph with a mistake in it still runs, all but the mistake. A block with
// an error — an input with no wire, inputs at two rates, part of a loop —
// is blocked, and so is everything downstream of it by any wire: those do not
// run and have nothing to read. The rest carries on. Taking one wire out of a
// running graph should silence what it fed, not stop the spectrum beside it;
// and a block that has not run must not be read as though it had, or an Audio
// out hands its last block to the speakers again on every packet.

import { BLOCK_BY_TYPE } from './blocks/index.js';
import { COMPLEX, CONTROL, MESSAGE, REAL, ensureBuffer, isStream, makeBuffer, outputsOf, sanitizeParams } from './block.js';
import { compile } from './graph.js';

// ── What each block costs ───────────────────────────────────────────────────
//
// Two figures per block, both for the editor to show on it:
//
//   latency   how late it makes the signal, from its own latency(), in seconds
//             — and, summed along the slowest path from the source, how late
//             the signal reaching it is. Where paths of different delay meet,
//             the later one is the answer: that is when both have arrived.
//   cpu       the share of one core it takes, measured: the time spent in its
//             process() over a window, divided by the stream time that window
//             covered. 0.05 is five percent of a core.
//
// A browser's clock is coarse on purpose — 5 µs at best, 100 µs or worse
// without cross-origin isolation — and most blocks take less than that per
// packet. The figure is still right on average, because each reading is a
// whole tick or none with odds in proportion to the real time, which is why it
// is a window's total and never a single packet's. The timing itself is two
// clock reads per block per packet: nothing beside the arithmetic it measures.

/** The mean of |x|² over a buffer's first n frames: complex or real. */
function meanSquare(buf, n) {
    const re = buf.re;
    const im = buf.im;
    let sum = 0;
    for (let k = 0; k < n; k++) sum += re[k] * re[k];
    if (im) for (let k = 0; k < n; k++) sum += im[k] * im[k];
    return sum / n;
}

/** Full scale: an audio sample this far from zero is clipped at the output. */
export const CLIP_AT = 1;

/** A mean square in dB, or null for none; silence reads as the floor. */
const toDb = (ms) => (ms == null ? null : ms > 1e-20 ? 10 * Math.log10(ms) : -200);

/**
 * The blocks that cannot run: every one with an error, or left out of the
 * order (a loop), and everything any of them feeds, however far on.
 */
function blockedBy(graph, plan) {
    const blocked = new Set();
    const ordered = new Set(plan.order);
    for (const n of graph.nodes) if (!ordered.has(n.id)) blocked.add(n.id);
    for (const e of plan.errors) if (e.node) blocked.add(e.node);
    const feeds = new Map();
    for (const [to, list] of Object.entries(plan.inputs)) {
        for (const f of list) {
            if (!f) continue;
            if (!feeds.has(f[0])) feeds.set(f[0], []);
            feeds.get(f[0]).push(to);
        }
    }
    const todo = Array.from(blocked);
    while (todo.length) {
        for (const to of feeds.get(todo.pop()) || []) {
            if (blocked.has(to)) continue;
            blocked.add(to);
            todo.push(to);
        }
    }
    return blocked;
}

/** One input's backlog, for a block whose inputs have to be lined up. */
class Queue {
    constructor(kind) {
        this.buf = makeBuffer(kind, 0);
        this.start = 0;
        this.count = 0;
        this.view = { re: null, im: null, n: 0 };
    }

    push(from) {
        const n = from.n;
        if (!n) return;
        const need = this.count + n;
        if (this.start + need > this.buf.re.length) {
            const old = this.buf;
            const end = this.start + this.count;
            if (need <= old.re.length) {
                // Room enough once the backlog is moved to the front.
                old.re.copyWithin(0, this.start, end);
                if (old.im) old.im.copyWithin(0, this.start, end);
            } else {
                const size = need * 2;
                const re = new Float64Array(size);
                re.set(old.re.subarray(this.start, end));
                let im = null;
                if (old.im) {
                    im = new Float64Array(size);
                    im.set(old.im.subarray(this.start, end));
                }
                this.buf = { re, im, n: 0 };
            }
            this.start = 0;
        }
        const at = this.start + this.count;
        this.buf.re.set(from.re.subarray(0, n), at);
        if (this.buf.im) this.buf.im.set(from.im.subarray(0, n), at);
        this.count += n;
    }

    /** The first `n` queued frames, as a buffer a block can read. */
    peek(n) {
        const v = this.view;
        v.re = this.buf.re.subarray(this.start, this.start + n);
        v.im = this.buf.im ? this.buf.im.subarray(this.start, this.start + n) : null;
        v.n = n;
        return v;
    }

    take(n) {
        this.start += n;
        this.count -= n;
        if (!this.count) this.start = 0;
    }
}

export class Runtime {
    /**
     * `graph` as parseGraph returns it. Nothing runs until there is a stream
     * rate — the first packet's, or setStreamRate.
     */
    constructor(graph, streamRate = 0, { now = () => performance.now() } = {}) {
        this.graph = graph;
        this.streamRate = streamRate;
        this._now = now;
        // Stream time processed since stats() last emptied the window.
        this._windowSec = 0;
        // Per node id: { type, params, inst, outs, queues, wired }.
        this.nodes = new Map();
        this.plan = null;
        this.errors = [];
        // The ids that do not run: see the note at the top.
        this.blocked = new Set();
        // Whether to measure each block's level in and out, and what was
        // measured: per node id, the mean square of the last packet's samples
        // on its first sample input and first sample output. Off unless an
        // editor is open to show them, so a graph left running costs nothing
        // for it. See levels().
        this.measureLevels = false;
        this._levels = new Map();
        this.build();
    }

    get ok() {
        return !!this.plan && this.plan.ok;
    }

    /**
     * Compile, and bring the instances into line with the graph. A node that
     * survives a rebuild keeps its instance and so its state: adding a meter
     * somewhere should not restart the filter beside it.
     */
    build() {
        const rate = this.streamRate || 12000;
        this.plan = compile(this.graph, rate);
        this.errors = this.plan.errors;
        const seen = new Set();
        for (const n of this.graph.nodes) {
            const type = BLOCK_BY_TYPE[n.type];
            if (!type) continue;
            seen.add(n.id);
            let node = this.nodes.get(n.id);
            if (!node || node.type !== type) {
                node = { type, inst: type.create(), params: null, rate: null };
                this.nodes.set(n.id, node);
            }
            node.params = sanitizeParams(type, n.params);
            // Which outputs carry audio or IQ — what has a level to measure.
            node.levelOut = outputsOf(n, type).findIndex((p) => p.kind === COMPLEX || p.kind === REAL);
            // Which audio output to watch for clipping, if any.
            node.audioOut = outputsOf(n, type).findIndex((p) => p.kind === REAL);
            node.outs = outputsOf(n, type).map((p, i) => (node.outs && node.outs[i] && node.outs[i].kind === makeBuffer(p.kind, 0).kind ? node.outs[i] : makeBuffer(p.kind, 0)));
            node.ports = this.plan.ports[n.id] || [];
            // Which inputs carry samples. Only those set how much a block
            // processes, and only those have to be lined up.
            node.streams = node.ports.map((p) => isStream(p.kind));
            const wired = (this.plan.inputs[n.id] || []).filter((f, i) => f && node.streams[i]).length;
            node.queues = wired > 1 ? node.ports.map((p) => (isStream(p.kind) ? new Queue(p.kind) : null)) : null;
            node.hasStreamOut = type.outputs.some((p) => isStream(p.kind));
            // What each control input last delivered, by its seq, and what the
            // parameters it drives have been set to.
            node.seen = node.ports.map(() => -1);
            node.driven = {};
            const r = this.plan.inRate[n.id];
            if (r > 0) {
                node.inst.configure(node.params, r);
                node.rate = r;
            }
            if (node.busyMs === undefined) node.busyMs = 0;
        }
        for (const id of Array.from(this.nodes.keys())) if (!seen.has(id)) this.nodes.delete(id);
        // Each input's source, resolved once: the buffer it reads is the
        // upstream node's output buffer object, which outlives a rebuild.
        for (const n of this.graph.nodes) {
            const node = this.nodes.get(n.id);
            if (!node) continue;
            node.from = (this.plan.inputs[n.id] || []).map((f) => {
                if (!f) return null;
                const up = this.nodes.get(f[0]);
                const upNode = this.graph.nodes.find((x) => x.id === f[0]);
                const at = up ? outputsOf(upNode, up.type).findIndex((p) => p.name === f[1]) : -1;
                return at >= 0 ? up.outs[at] : null;
            });
        }
        this.blocked = blockedBy(this.graph, this.plan);
        // Nothing left on a blocked block's outputs for anything to read.
        for (const id of this.blocked) {
            const node = this.nodes.get(id);
            if (!node) continue;
            for (const o of node.outs) {
                o.n = 0;
                if (o.kind === MESSAGE) o.list = [];
            }
        }
        this._latencies();
        return this.ok;
    }

    /** A new graph — rebuilt, keeping the state of every node still in it. */
    setGraph(graph) {
        this.graph = graph;
        return this.build();
    }

    /** Change some of one node's parameters. Rebuilds if a rate moved. */
    setParams(id, patch) {
        const n = this.graph.nodes.find((x) => x.id === id);
        const node = this.nodes.get(id);
        if (!n || !node) return false;
        n.params = sanitizeParams(node.type, { ...n.params, ...patch });
        node.params = n.params;
        const before = this.plan.outRate[id];
        const after = node.type.rate ? node.type.rate(node.rate, node.params) : node.rate;
        if (after !== before) return this.build();
        node.inst.configure(node.params, node.rate);
        this._latencies();
        return true;
    }

    /** Each node's own delay and the delay of the signal reaching its output. */
    _latencies() {
        for (const id of this.plan.order) {
            const node = this.nodes.get(id);
            if (!node) continue;
            const samples = node.inst.latency ? node.inst.latency() : 0;
            node.latencySec = node.rate > 0 && samples > 0 ? samples / node.rate : 0;
            let before = 0;
            for (const f of this.plan.inputs[id] || []) {
                if (!f) continue;
                const up = this.nodes.get(f[0]);
                if (up && up.totalSec > before) before = up.totalSec;
            }
            node.totalSec = before + node.latencySec;
        }
    }

    /** `{ own, total }` in seconds for one node, or null. */
    latencyOf(id) {
        const node = this.nodes.get(id);
        return node && node.totalSec !== undefined ? { own: node.latencySec, total: node.totalSec } : null;
    }

    /**
     * Every node's cost since the last call: `{ windowSec, cpu, nodes }`, where
     * `nodes[id]` is `{ cpu, latencySec, totalLatencySec }` and `cpu` overall is
     * their sum. CPU is null until some stream time has passed. Empties the
     * window unless `keep`.
     */
    stats({ keep = false } = {}) {
        // Fresh each time: the carrier tracker resizes its filters as the
        // carrier moves, so its delay can change with no setting changing.
        if (this.plan) this._latencies();
        const win = this._windowSec;
        const nodes = {};
        let total = 0;
        for (const [id, node] of this.nodes) {
            const cpu = win > 0 ? node.busyMs / 1000 / win : null;
            if (cpu != null) total += cpu;
            nodes[id] = { cpu, latencySec: node.latencySec || 0, totalLatencySec: node.totalSec || 0 };
            if (!keep) node.busyMs = 0;
        }
        if (!keep) this._windowSec = 0;
        return { windowSec: win, cpu: win > 0 ? total : null, nodes };
    }

    setStreamRate(rate) {
        if (rate === this.streamRate) return this.ok;
        this.streamRate = rate;
        return this.build();
    }

    /** Forget all history, as a fresh start would. */
    reset() {
        for (const node of this.nodes.values()) {
            node.inst.reset();
            if (node.queues) for (const q of node.queues) { q.start = 0; q.count = 0; }
        }
    }

    /**
     * Set the parameters a node's control inputs drive, from what they last
     * put out — only on a new value, so a control held still costs nothing,
     * and only when it differs, so a filter is not redesigned to the same
     * shape.
     */
    _applyControls(id, node) {
        let patch = null;
        node.ports.forEach((p, i) => {
            if (!p.param || p.kind !== CONTROL) return;
            const buf = node.from[i];
            if (!buf || buf.seq === node.seen[i]) return;
            node.seen[i] = buf.seq;
            const v = buf.value;
            if (v == null || !Number.isFinite(Number(v))) return;
            const spec = node.type.params[p.param];
            const value = spec.kind === 'bool' ? Number(v) >= 0.5 : Number(v);
            if (node.params[p.param] === value) return;
            patch = patch || {};
            patch[p.param] = value;
        });
        if (!patch) return;
        node.params = sanitizeParams(node.type, { ...node.params, ...patch });
        for (const k of Object.keys(patch)) node.driven[k] = node.params[k];
        node.inst.configure(node.params, node.rate);
    }

    /**
     * Parameters that controls have moved, by node: `{ id: { param: value } }`.
     * The stored graph keeps what the operator set; this is what is in force.
     */
    driven() {
        const out = {};
        for (const [id, node] of this.nodes) {
            if (node.driven && Object.keys(node.driven).length) out[id] = { ...node.driven };
        }
        return out;
    }

    /** Hand a node data it plays from — an IQ player's file. */
    load(id, data) {
        const node = this.nodes.get(id);
        if (!node || !node.inst.load) return false;
        node.inst.load(data);
        return true;
    }

    /** Pass a one-off action to one node — see `command` in block.js. */
    command(id, name) {
        const node = this.nodes.get(id);
        if (!node || !node.inst.command) return false;
        node.inst.command(name);
        return true;
    }

    /** What one node has to report — a meter's level, a sink's audio — or null. */
    read(id) {
        if (this.blocked.has(id)) return null;
        const node = this.nodes.get(id);
        return node && node.inst.read ? node.inst.read() : null;
    }

    /**
     * Run one packet: `{ i, q, frames, rate }`, I and Q of the stream. With no
     * receiver, `i` and `q` can be null and the sources make their own.
     */
    process(stream) {
        if (stream.rate > 0 && stream.rate !== this.streamRate) this.setStreamRate(stream.rate);
        // False when nothing can run: every block blocked.
        if (!this.plan || (this.blocked.size > 0 && this.blocked.size >= this.graph.nodes.length)) return false;
        if (stream.frames > 0 && this.streamRate > 0) this._windowSec += stream.frames / this.streamRate;
        for (const id of this.plan.order) {
            if (this.blocked.has(id)) continue;
            const node = this.nodes.get(id);
            const type = node.type;
            const from = node.from;
            this._applyControls(id, node);
            // A packet's messages are that packet's: last time's are gone.
            for (const o of node.outs) if (o.kind === MESSAGE) o.list = [];
            const anyStreamIn = node.streams.some((st, i) => st && from[i]);
            let n;
            let ins;
            if (!anyStreamIn) {
                // A source makes a packet's worth; a block of controls and
                // messages alone runs once a packet with no samples.
                n = !node.hasStreamOut ? 0
                    : node.inst.framesFor ? node.inst.framesFor(stream.frames, this.streamRate) : stream.frames;
                ins = from.map((f) => f || null);
            } else if (node.queues) {
                n = Infinity;
                from.forEach((f, i) => {
                    if (!f || !node.streams[i]) return;
                    node.queues[i].push(f);
                    n = Math.min(n, node.queues[i].count);
                });
                ins = from.map((f, i) => (!f ? null : node.streams[i] ? node.queues[i].peek(n) : f));
            } else {
                ins = from.map((f) => f || null);
                n = ins.find((f, i) => f && node.streams[i]).n;
            }
            // Nothing arrived: a block with sample outputs stays as it was, as
            // the panel's chain does when a short packet decimates to nothing.
            // Anything else still runs, so audio out reports that there is
            // none and a meter keeps its reading.
            if (anyStreamIn && !n && node.hasStreamOut) {
                for (const o of node.outs) if (isStream(o.kind) || o.re) o.n = 0;
                continue;
            }
            const cap = type.maxOut ? type.maxOut(n, node.params, node.rate) : n;
            for (const o of node.outs) ensureBuffer(o, cap);
            const t0 = this._now();
            const m = node.inst.process(ins, node.outs, n, stream);
            node.busyMs += this._now() - t0;
            for (const o of node.outs) if (o.re) o.n = m;
            if (this.measureLevels) this._measure(id, node, ins, n);
            if (node.queues) node.queues.forEach((q, i) => { if (q && from[i]) q.take(n); });
        }
        return true;
    }

    /** One block's level in and out, from this packet. */
    _measure(id, node, ins, n) {
        let lv = this._levels.get(id);
        if (!lv) {
            lv = { in: null, out: null, act: 0, peak: 0, clip: 0, audio: false };
            this._levels.set(id, lv);
        }
        // Activity: what arrived on its message inputs — a character of text
        // each, one for any other message — or the block's own measure of it,
        // where it has one (a Morse decoder's key going down).
        if (node.inst.activity) {
            lv.act += node.inst.activity();
        } else {
            node.ports.forEach((p, i) => {
                if (p.kind !== MESSAGE || !ins[i] || !ins[i].list) return;
                for (const m of ins[i].list) lv.act += m && typeof m.text === 'string' ? m.text.length : 1;
            });
        }
        const at = node.ports.findIndex((p, i) => (p.kind === COMPLEX || p.kind === REAL) && ins[i]);
        if (at >= 0 && n > 0) lv.in = meanSquare(ins[at], n);
        const out = node.levelOut >= 0 ? node.outs[node.levelOut] : null;
        if (out && out.n > 0) lv.out = meanSquare(out, out.n);
        // Audio over full scale: on its audio output, or — for a sink, with
        // none — its audio input. Nothing clips in floating point until it
        // reaches the speakers or a file; there, anything past ±1 does.
        let audio = node.audioOut >= 0 ? node.outs[node.audioOut] : null;
        let m = audio ? audio.n : 0;
        if (!audio) {
            const ai = node.ports.findIndex((p, i) => p.kind === REAL && ins[i]);
            if (ai >= 0) { audio = ins[ai]; m = n; }
        }
        if (audio) {
            lv.audio = true;
            const x = audio.re;
            for (let k = 0; k < m; k++) {
                const a = x[k] < 0 ? -x[k] : x[k];
                if (a > lv.peak) lv.peak = a;
                if (a >= CLIP_AT) lv.clip++;
            }
        }
    }

    /**
     * Every running block's level, in dBFS — the mean power of its last
     * packet, as the Level meter block measures it — on its first sample
     * input (`in`) and output (`out`), null for a side it does not have or
     * that has had nothing; `act`, how much activity since the last call
     * (see _measure); and for a block with audio, `peak` — its loudest
     * sample since the last call, dBFS — and `clip`, how many samples were
     * at or past full scale. Each call starts those three again. Measured
     * only while `measureLevels` is set.
     */
    levels() {
        const out = {};
        for (const [id, lv] of this._levels) {
            if (this.blocked.has(id) || !this.nodes.has(id)) continue;
            out[id] = { in: toDb(lv.in), out: toDb(lv.out), act: lv.act };
            if (lv.audio) {
                out[id].peak = lv.peak > 0 ? 20 * Math.log10(lv.peak) : -200;
                out[id].clip = lv.clip;
            }
            lv.act = 0;
            lv.peak = 0;
            lv.clip = 0;
        }
        return out;
    }
}
