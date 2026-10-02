// The playground as a thing with a lifetime: the graph, the worker running it,
// the audio it makes and the recordings it keeps.
//
// Same shape as the IQ Demod panel's engine (lib/iqDemod.js), for the same
// reason — a modal that is closed is unmounted, and a playground that stopped
// when its window shut would leave the receiver in IQ with the duck down and
// nothing on screen to say why. So this is a plain object living as long as the
// page, and the interface is a view over it. components/PlaygroundWatch.jsx
// pushes in what it cannot see for itself: whether the stream really is IQ, and
// the receiver's volume.
//
// ── A packet's journey ──────────────────────────────────────────────────────
//
//   player tap ─► copy ─► worker: runtime ─► back: each Audio out's block,
//                                                   each recorder's block,
//                                                   readings when due
//                                          ─► AudioRoutes (device, channel)
//                                          ─► WavRecording (if recording)
//
// The planes are copied because the player reuses them, and the copies are
// transferred, not cloned, into the worker. A worker that falls behind is not
// allowed to build an unbounded queue: past MAX_IN_FLIGHT packets awaiting an
// answer, new ones are dropped and the playground says it is overloaded.

import { Emitter } from '../radio/emitter.js';
import { claimIQ, releaseIQ } from '../lib/iqExclusive.js';
import { AudioRoutes } from '../lib/audioRoutes.js';
import { planFor } from '../lib/iqDemod.js';
import { parseGraph, serializeGraph } from './graph.js';
import { graphForPlan } from './fromPlan.js';
import { autoLayout } from './geometry.js';
import { createHost } from './host.js';
import { WavRecording } from './recording.js';
import { BLOCK_BY_TYPE } from './blocks/index.js';
import { sanitizeParams } from './block.js';
import { saveFile } from '../lib/saveFile.js';

export const STORAGE_KEY = 'ubersdr.v2.playground';
const WRITE_DELAY_MS = 250;

// Packets handed to the worker and not yet answered. Twenty-five is half a
// second of 20 ms packets: well past any honest scheduling hiccup, and short of
// the point where the audio would be hopelessly late anyway.
export const MAX_IN_FLIGHT = 25;
// How long "overloaded" is shown after the last dropped packet.
const OVERLOAD_HOLD_MS = 2000;

// A graph with no IQ stream in it — one playing a file, or a generator — runs
// on a clock of its own, in packets this long, at this rate for its sources
// that follow the clock (a player follows its file). Behind by more than the
// cap, it catches up no further: a tab that was asleep should not wake to a
// minute of packets at once.
const OFFLINE_PACKET_MS = 20;
export const OFFLINE_RATE = 48000;
const OFFLINE_CATCH_UP_MS = 200;

/** Whether a graph listens to the receiver, as against running by itself. */
export const needsReceiver = (graph) => graph.nodes.some((n) => n.type === 'iq-in');

/** The IQ mode a graph's stream is built for, from its IQ stream block; null without one. */
export function graphIqWidth(graph) {
    const n = graph.nodes.find((x) => x.type === 'iq-in');
    return n ? n.params.width || 'iq' : null;
}

/** What a playground holds before anybody has built anything: USB at the dial. */
export function defaultGraph() {
    const plan = planFor({ mode: 'usb', offsetHz: 0, widthHz: 2700, lowCutHz: 50 });
    return autoLayout(parseGraph(graphForPlan(plan, 12000, { adaptive: true })).graph);
}

function loadGraph() {
    try {
        const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        if (raw) {
            const { graph } = parseGraph(raw);
            if (graph.nodes.length) return graph;
        }
    } catch (err) { /* private mode, or something unreadable: start fresh */ }
    return defaultGraph();
}

export class PlaygroundEngine extends Emitter {
    /**
     * `player` is the receiver's AudioPlayer. `hostFactory` is how a host is
     * made, for the tests to run the graph inline.
     */
    constructor(player, { hostFactory = createHost, now = () => performance.now() } = {}) {
        super();
        this.player = player;
        this._hostFactory = hostFactory;
        this._now = now;
        this.graph = loadGraph();
        this.active = false;
        this._quad = false;
        this._ducking = false;
        // The mode to go back to on Stop — see lib/iqExclusive.js.
        this.restoreMode = null;
        this.host = null;
        this._heard = false;
        this._seq = 0;
        this.inFlight = 0;
        this._overloadUntil = -Infinity;
        this.ok = true;
        this.errors = [];
        this.fault = null;
        this.costMs = 0;
        this.streamRate = 0;
        this.readings = {};
        // Each block's level in and out, in dBFS, while an editor asks for
        // them (watch's `levels`): { id: { in, out } }.
        this.levels = {};
        this._watchLevels = false;
        // Parameters that control inputs have moved, by node — what is in
        // force rather than what was set. See Runtime.driven.
        this.driven = {};
        // Each block's CPU share and latency, about once a second while
        // running — see Runtime.stats.
        this.stats = null;
        this._watch = [];
        this._untap = null;
        this._writeTimer = null;
        this.recordings = new Map();
        // IQ players' files, by node id: kept here so a worker that is
        // started again can be handed them again.
        this.files = new Map();
        // Running by itself, with no receiver: see needsReceiver.
        this.offline = false;
        this._clock = null;
        this.routes = new AudioRoutes(player, () => this.emit('change'));
    }

    get running() {
        return this.active;
    }

    /** Running *and* receiving quadrature. */
    get quadrature() {
        return this._quad;
    }

    /** Whether packets have lately been dropped because the graph fell behind. */
    get overloaded() {
        return this._now() < this._overloadUntil;
    }

    /** Where the graph is running: 'worker', 'inline', or null while stopped. */
    get hostKind() {
        return this.host ? this.host.kind : null;
    }

    // ── the graph ───────────────────────────────────────────────────────────

    /** Replace the graph. It is stored, and a running worker gets it at once. */
    setGraph(graph) {
        const was = needsReceiver(this.graph);
        this.graph = parseGraph(graph).graph;
        // From playing a file to listening to the receiver, or back, is a
        // different way of running: stop, and let Start begin the new one.
        if (this.active && needsReceiver(this.graph) !== was) this.stop();
        this._persist();
        this._afterGraph();
        if (this.host) this.host.send({ t: 'graph', graph: this.graph });
        this.emit('change');
    }

    /** Change some of one node's parameters. */
    setParams(id, patch) {
        const n = this.graph.nodes.find((x) => x.id === id);
        if (!n) return;
        n.params = sanitizeParams(BLOCK_BY_TYPE[n.type], { ...n.params, ...patch });
        this._persist();
        if (this.host) this.host.send({ t: 'params', id, patch: n.params });
        this.emit('change');
    }

    /**
     * Move blocks on the canvas. Positions are the editor's alone, so this is
     * stored but not sent: rebuilding the worker's graph on every frame of a
     * drag would cost a recompile for nothing it uses.
     */
    setPositions(positions) {
        let moved = false;
        for (const n of this.graph.nodes) {
            const at = positions[n.id];
            if (!at) continue;
            n.x = Math.round(at.x);
            n.y = Math.round(at.y);
            moved = true;
        }
        if (!moved) return;
        this._persist();
        this.emit('change');
    }

    /**
     * Resize a card: `size` is `{ w, h }` as fitSize gives it — a side left
     * out is natural — or null for its natural size. Like positions, the
     * editor's alone: stored, not sent.
     */
    setSize(id, size) {
        const n = this.graph.nodes.find((x) => x.id === id);
        if (!n) return;
        const w = size && size.w ? size.w : undefined;
        const h = size && size.h ? size.h : undefined;
        if (n.w === w && n.h === h) return;
        if (w) n.w = w; else delete n.w;
        if (h) n.h = h; else delete n.h;
        this._persist();
        this.emit('change');
    }

    /** A one-off action for one node, such as arming a scope's single sweep. */
    command(id, name) {
        if (this.host) this.host.send({ t: 'command', id, name });
    }

    /** Which nodes' readings to keep up to date in `readings`. */
    watch(ids, { levels = false } = {}) {
        this._watch = Array.isArray(ids) ? ids.slice() : [];
        this._watchLevels = !!levels;
        if (!this._watchLevels) this.levels = {};
        if (this.host) this.host.send({ t: 'watch', ids: this._watch, levels: this._watchLevels });
    }

    /** The parameters of one node as they stand. */
    paramsOf(id) {
        const n = this.graph.nodes.find((x) => x.id === id);
        return n ? n.params : null;
    }

    /** Why a node's chosen output device is not being used, or null. */
    sinkErrorOf(id) {
        const p = this.paramsOf(id);
        return p && p.device ? this.routes.errorFor(p.device) : null;
    }

    _persist() {
        clearTimeout(this._writeTimer);
        this._writeTimer = setTimeout(() => this.flush(), WRITE_DELAY_MS);
    }

    /** Write the graph to storage now rather than after the drag settles. */
    flush() {
        clearTimeout(this._writeTimer);
        this._writeTimer = null;
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeGraph(this.graph)));
        } catch (err) { /* private browsing, a full quota — not worth failing over */ }
    }

    /** Voices and recordings for nodes that have gone are let go. */
    _afterGraph() {
        const ids = new Set(this.graph.nodes.map((n) => n.id));
        for (const id of Array.from(this.files.keys())) if (!ids.has(id)) this.files.delete(id);
        this.routes.prune(this.graph.nodes.filter((n) => n.type === 'audio-out').map((n) => n.id));
        for (const [id, rec] of Array.from(this.recordings)) {
            if (ids.has(id)) continue;
            if (rec.state === 'recording') rec.stop('Stopped: the recorder was removed.');
            if (rec.state !== 'held') this.recordings.delete(id);
        }
    }

    // ── running ─────────────────────────────────────────────────────────────

    start() {
        if (this.active) return;
        this.offline = !needsReceiver(this.graph);
        if (!this.offline) {
            const inherited = claimIQ(this);
            if (inherited && !this.restoreMode) this.restoreMode = inherited;
        }
        this.active = true;
        this.fault = null;
        this.inFlight = 0;
        this._heard = false;
        this._resetCounts();
        this.routes.allowOwnContext(this.offline);
        this._openHost();
        if (this.offline) this._startClock();
        else this._untap = this.player.onAudio((planes, frames, rate) => this._onAudio(planes, frames, rate));
        this._applyDuck();
        this.emit('change');
    }

    stop() {
        if (!this.active) return;
        this.active = false;
        releaseIQ(this);
        if (this._untap) this._untap();
        this._untap = null;
        this._stopClock();
        for (const rec of this.recordings.values()) rec.stop('Stopped: the playground was stopped.');
        this._closeHost();
        this._applyDuck();
        this.routes.teardown();
        this.inFlight = 0;
        this.readings = {};
        this.levels = {};
        this.stats = null;
        this.emit('change');
    }

    /** Whether the stream arriving is a quadrature pair, i.e. the receiver is in IQ. */
    setQuadrature(on) {
        const next = !!on;
        if (next === this._quad) return;
        this._quad = next;
        if (next) {
            if (this.host) this.host.send({ t: 'reset' });
            this.routes.resync();
        }
        this._applyDuck();
        this.emit('change');
    }

    /** The receiver's volume and mute, pushed in from outside. */
    setOutput(volume, muted) {
        this.routes.setOutput(volume, muted);
    }

    _openHost(kind) {
        this.host = this._hostFactory((m) => this._onMessage(m), kind === 'inline' ? { worker: false } : undefined);
        this.host.send({ t: 'graph', graph: this.graph });
        this.host.send({ t: 'watch', ids: this._watch, levels: !!this._watchLevels });
        for (const id of this.files.keys()) this._sendFile(id);
    }

    _closeHost() {
        if (this.host) this.host.close();
        this.host = null;
    }

    /** Packets for a graph that runs by itself, paced by the wall clock. */
    _startClock() {
        this._stopClock();
        let last = this._now();
        // Time not yet sent as packets, carried from tick to tick so the
        // packets keep pace with the clock however the timer happens to fire.
        let owed = 0;
        const frames = Math.round((OFFLINE_RATE * OFFLINE_PACKET_MS) / 1000);
        const tick = () => {
            if (!this.active || !this.host) return;
            const now = this._now();
            owed = Math.min(OFFLINE_CATCH_UP_MS, owed + (now - last));
            last = now;
            while (owed >= OFFLINE_PACKET_MS) {
                owed -= OFFLINE_PACKET_MS;
                this._send(null, null, frames, OFFLINE_RATE);
            }
        };
        this._clock = setInterval(tick, OFFLINE_PACKET_MS / 2);
        this._tick = tick;
    }

    _stopClock() {
        if (this._clock) clearInterval(this._clock);
        this._clock = null;
    }

    /** One packet to the host, unless it is too far behind to take one. */
    _send(i, q, frames, rate) {
        this.streamRate = rate;
        if (this.inFlight >= MAX_IN_FLIGHT) {
            const first = !this.overloaded;
            this._overloadUntil = this._now() + OVERLOAD_HOLD_MS;
            if (first) this.emit('change');
            return;
        }
        this.inFlight++;
        this.host.send({ t: 'packet', seq: ++this._seq, i, q, frames, rate }, i ? [i.buffer, q.buffer] : []);
    }

    /**
     * Load an IQ file (decodeWav's result) into a player node: its rate and
     * name go into the graph, its samples to the worker, and a copy stays here
     * for the next time the worker starts.
     */
    loadFile(id, data, name = '') {
        const n = this.graph.nodes.find((x) => x.id === id);
        if (!n || n.type !== 'iq-player' || !data) return false;
        this.files.set(id, { i: data.i, q: data.q, frames: data.frames, rate: data.rate });
        this.setParams(id, {
            rateHz: data.rate,
            fileName: String(name).slice(0, 200),
            ...(data.centreHz ? { centreHz: data.centreHz } : {}),
        });
        this._sendFile(id);
        return true;
    }

    _sendFile(id) {
        const f = this.files.get(id);
        if (!f || !this.host) return;
        const i = f.i.slice();
        const q = f.q.slice();
        this.host.send({ t: 'load', id, data: { i, q, frames: f.frames, rate: f.rate } }, [i.buffer, q.buffer]);
    }

    _resetCounts() {
        this._counts = {
            since: this._now(), packets: 0, frames: 0, behind: 0,
            underrunsAt: (this.player && this.player.underruns) || 0,
        };
    }

    /**
     * What the IQ stream has brought since Start: packets and samples handed
     * to the graph, packets dropped because the graph was too far behind to
     * take them (`behind`), and the receiver player's underruns — its
     * dropouts — counted from Start. `sinceMs` is when Start was, on this
     * engine's clock.
     */
    streamCounts() {
        const c = this._counts || { since: this._now(), packets: 0, frames: 0, behind: 0, underrunsAt: 0 };
        const now = (this.player && this.player.underruns) || 0;
        return {
            sinceMs: c.since,
            packets: c.packets,
            frames: c.frames,
            behind: c.behind,
            underruns: Math.max(0, now - c.underrunsAt),
            rate: this.streamRate || 0,
        };
    }

    /** Whether a player node has a file in it. */
    hasFile(id) {
        return this.files.has(id);
    }

    _applyDuck() {
        const want = this.active && this._quad && !this.offline;
        if (want === this._ducking) return;
        this._ducking = want;
        this.player.setDucked(want);
    }

    _onAudio(planes, frames, sampleRate) {
        if (!this.active || !this._quad || !frames || !this.host) return;
        if (planes.length < 2) return;
        this._counts.packets++;
        this._counts.frames += frames;
        // Re-asserted, as the IQ Demod engine does: another panel's preview
        // can lift the duck on its way out.
        if (!this.player.ducked) this.player.setDucked(true);
        if (this.inFlight >= MAX_IN_FLIGHT) {
            this._counts.behind++;
            this._send(null, null, frames, sampleRate);
            return;
        }
        this._send(planes[0].slice(0, frames), planes[1].slice(0, frames), frames, sampleRate);
    }

    _onMessage(m) {
        if (!m || !this.active) return;
        switch (m.t) {
            case 'status':
                this._heard = true;
                this.ok = m.ok;
                this.errors = m.errors || [];
                this.emit('change');
                break;
            case 'fault':
                // A worker that never answered at all could not be loaded —
                // run the graph here instead rather than not at all.
                if (this.host && this.host.kind === 'worker' && !this._heard) {
                    this._closeHost();
                    this.inFlight = 0;
                    this._openHost('inline');
                    this.emit('change');
                    break;
                }
                this.fault = m.message;
                this.emit('change');
                break;
            case 'out':
                this._heard = true;
                this.inFlight = Math.max(0, this.inFlight - 1);
                this.costMs = m.ms || 0;
                this._deliver(m);
                break;
            default:
                break;
        }
    }

    _deliver(m) {
        for (const a of m.audio || []) {
            const p = this.paramsOf(a.id);
            if (!p) continue;
            this.routes.play(a.id, a.samples, a.frames, a.rate, p);
        }
        let stopped = false;
        for (const r of m.record || []) {
            const rec = this.recordings.get(r.id);
            if (rec && rec.push(r.left, r.right, r.frames, r.rate)) stopped = true;
        }
        if (stopped) this.emit('change');
        if (m.readings) {
            const { __driven: driven, __levels: levels, ...readings } = m.readings;
            this.readings = readings;
            // Each block's level in and out, in dBFS, while an editor asks.
            this.levels = levels || {};
            this.driven = driven || {};
            this.emit('readings');
        }
        if (m.stats) {
            this.stats = m.stats;
            this.emit('stats');
        }
    }

    // ── recording ───────────────────────────────────────────────────────────

    /** A recorder node's recording, made on first asking. */
    recordingOf(id) {
        let rec = this.recordings.get(id);
        if (!rec) {
            rec = new WavRecording();
            this.recordings.set(id, rec);
        }
        return rec;
    }

    /**
     * Start recording a recorder node. `label` goes into the file name — the
     * IQ recorder's frequency, say, so the player can label it again.
     */
    startRecording(id, label = '') {
        const p = this.paramsOf(id);
        if (!p || !this.active) return false;
        this.recordingOf(id).start(p.maxSeconds, Date.now(), label);
        this.emit('change');
        return true;
    }

    stopRecording(id) {
        const rec = this.recordings.get(id);
        if (!rec) return;
        rec.stop();
        this.emit('change');
    }

    /**
     * Hand a held recording to the browser as a file — through saveFile, so
     * the phone apps get it too.
     */
    async saveRecording(id) {
        const rec = this.recordings.get(id);
        const blob = rec && rec.blob();
        if (!blob) return false;
        await saveFile(blob, rec.filename());
        return true;
    }

    clearRecording(id) {
        const rec = this.recordings.get(id);
        if (!rec) return;
        rec.clear();
        this.recordings.delete(id);
        this.emit('change');
    }

    destroy() {
        this.stop();
        this.flush();
        for (const rec of this.recordings.values()) rec.clear();
        this.recordings.clear();
    }
}

let engine = null;

/** The one playground. Built on first use, like the IQ Demod engine. */
export function getPlayground(player) {
    if (!engine) engine = new PlaygroundEngine(player);
    return engine;
}
