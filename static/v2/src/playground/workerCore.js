// The graph's side of the conversation between the page and the playground's
// worker.
//
// A graph is arbitrary arithmetic chosen by the operator, so it does not run on
// the page: the IQ Demod panel's own demodulators already showed that a few of
// them on a wide stream can take the main thread down with them. It runs in a
// worker, and this is that worker's whole job — kept separate from the worker
// entry so the same code also runs on the page when a worker cannot be made,
// and under node in the tests, by handing it a different `post`.
//
// ── Page to worker ───────────────────────────────────────────────────────────
//
//   { t: 'graph', graph }                   replace the graph (parseGraph form)
//   { t: 'params', id, patch }              change one node's parameters
//   { t: 'reset' }                          forget all history
//   { t: 'watch', ids }                     which nodes' readings to send back
//   { t: 'command', id, name }              a one-off action for one node (a
//                                           scope's arm, stop, run)
//   { t: 'load', id, data }                 a file for a node to play — an IQ
//                                           player's samples, transferred
//   { t: 'packet', seq, i, q, frames, rate } one packet of IQ; i and q are
//                                           transferred, not copied
//
// ── Worker to page ───────────────────────────────────────────────────────────
//
//   { t: 'status', ok, errors }             after every graph or parameter change
//   { t: 'out', seq, audio, record, readings, stats, ms }
//                                           after every packet: each Audio out's
//                                           samples, each recorder's, the watched
//                                           readings when they are due, every
//                                           block's CPU and latency once a second
//                                           (Runtime.stats), and what the packet
//                                           cost
//   { t: 'fault', message }                 the graph threw; nothing more runs
//                                           until a new graph arrives

import { Runtime } from './runtime.js';
import { parseGraph } from './graph.js';

// Readings — meters, spectra, a tracker's state — go back at most this often.
// The Signal panel's meters are sampled at the same rate, and a spectrum is a
// transform per watched node, so this is also what keeps them cheap.
export const READ_EVERY_MS = 80;

// Each block's CPU share and latency go back once a second: a measurement over
// a window, so a longer window is a steadier figure, and nobody reads a
// percentage faster than this.
export const STATS_EVERY_MS = 1000;

/** A copy of a reading that can be posted without dragging a whole buffer along. */
function detach(value) {
    if (ArrayBuffer.isView(value)) return value.slice();
    if (Array.isArray(value)) return value.map(detach);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = detach(v);
        return out;
    }
    return value;
}

/**
 * `post(message, transfer)` sends to the page. `now()` is a clock in ms, for
 * the readings' pacing and the cost figure.
 */
export function createWorkerCore(post, now = () => performance.now()) {
    let rt = null;
    let faulted = false;
    let watch = [];
    let lastRead = -Infinity;
    let lastStats = null;
    let audioIds = [];
    let recordIds = [];
    let parseErrors = [];

    const status = () => {
        post({
            t: 'status',
            ok: !!rt && rt.ok && !faulted,
            errors: [...parseErrors, ...(rt ? rt.errors : [])],
        });
    };

    const sinks = (graph) => {
        audioIds = graph.nodes.filter((n) => n.type === 'audio-out').map((n) => n.id);
        recordIds = graph.nodes.filter((n) => n.type === 'wav-recorder' || n.type === 'iq-recorder').map((n) => n.id);
    };

    const packet = (m) => {
        const started = now();
        rt.process({ i: m.i, q: m.q, frames: m.frames, rate: m.rate });
        const transfer = [];
        const audio = [];
        for (const id of audioIds) {
            const r = rt.read(id);
            if (!r || !r.frames) continue;
            const samples = r.samples.slice();
            transfer.push(samples.buffer);
            audio.push({ id, samples, frames: r.frames, rate: r.rate });
        }
        const record = [];
        for (const id of recordIds) {
            const r = rt.read(id);
            if (!r || !r.frames) continue;
            const left = r.left.slice();
            const right = r.right ? r.right.slice() : null;
            transfer.push(left.buffer);
            if (right) transfer.push(right.buffer);
            record.push({ id, left, right, frames: r.frames, rate: r.rate });
        }
        let readings = null;
        if (started - lastRead >= READ_EVERY_MS) {
            // What controls have set, for the editor to show in place of
            // what the operator set — see Runtime.driven. Sent with the
            // readings, and whenever there is any even if nothing is watched.
            const driven = rt.driven();
            const anyDriven = Object.keys(driven).length > 0;
            if (watch.length || anyDriven) {
                lastRead = started;
                readings = {};
                for (const id of watch) {
                    const r = rt.read(id);
                    if (r) readings[id] = detach(r);
                }
                if (anyDriven) readings.__driven = driven;
            }
        }
        let stats = null;
        if (lastStats === null) lastStats = started;
        else if (started - lastStats >= STATS_EVERY_MS) {
            lastStats = started;
            stats = rt.stats();
        }
        post({ t: 'out', seq: m.seq, audio, record, readings, stats, ms: now() - started }, transfer);
    };

    return {
        onMessage(m) {
            if (!m || typeof m !== 'object') return;
            try {
                switch (m.t) {
                    case 'graph': {
                        const parsed = parseGraph(m.graph);
                        parseErrors = parsed.errors;
                        faulted = false;
                        if (rt) rt.setGraph(parsed.graph);
                        else rt = new Runtime(parsed.graph, m.rate || 0, { now });
                        rt.stats();
                        lastStats = null;
                        sinks(parsed.graph);
                        status();
                        break;
                    }
                    case 'params':
                        if (rt) {
                            rt.setParams(m.id, m.patch);
                            status();
                        }
                        break;
                    case 'reset':
                        if (rt) rt.reset();
                        break;
                    case 'load':
                        if (rt) rt.load(m.id, m.data);
                        break;
                    case 'command':
                        if (rt) rt.command(m.id, m.name);
                        // The next readings show the result at once, rather
                        // than up to a reading's interval later.
                        lastRead = -Infinity;
                        break;
                    case 'watch':
                        watch = Array.isArray(m.ids) ? m.ids.slice() : [];
                        lastRead = -Infinity;
                        break;
                    case 'packet':
                        if (!rt || faulted) {
                            post({ t: 'out', seq: m.seq, audio: [], record: [], readings: null, ms: 0 });
                            break;
                        }
                        packet(m);
                        break;
                    default:
                        break;
                }
            } catch (err) {
                // A block that throws stops the graph rather than the worker:
                // the page hears why, and a new graph starts it again.
                faulted = true;
                post({ t: 'fault', message: (err && err.message) || String(err) });
                if (m.t === 'packet') post({ t: 'out', seq: m.seq, audio: [], record: [], readings: null, ms: 0 });
            }
        },
    };
}
