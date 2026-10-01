// One-block decoders: RTTY, PSK31, CW and NAVTEX as a single block each —
// IQ in, text out — for anyone who wants the text rather than the modem.
//
// Each is a small graph of the digital blocks run inside the block by its own
// Runtime, so it is those blocks, stage for stage, and Expand (playground/
// expand.js) lays exactly that graph out on the canvas in its place: the same
// text, and every stage to probe.
//
// Every one takes the signal anywhere in its input — `offsetHz` says where,
// from the input's zero — and shifts it to zero itself.

import { COMPLEX, MESSAGE } from '../block.js';
// A cycle — runtime.js reaches every block, these included — which is safe
// because neither is used until a decoder is configured, long after every
// module has loaded.
import { GRAPH_VERSION, parseGraph } from '../graph.js';
import { Runtime } from '../runtime.js';

const OFFSET = { kind: 'number', label: 'Offset', unit: 'Hz', default: 0, min: -192000, max: 192000, step: 1, live: true };

/**
 * A decoder's inside: `stages` are the blocks after the shift, each
 * `{ id, type, params }`, fed in order unless it says `from`; `text` is the
 * [id, port] its text comes out of.
 */
function inside(p, stages, text) {
    const nodes = [{ id: 'shift', type: 'shift', params: { frequencyHz: -p.offsetHz } }];
    const wires = [];
    let prev = ['shift', 'out'];
    for (const s of stages) {
        nodes.push({ id: s.id, type: s.type, params: s.params || {} });
        const into = s.into || 'in';
        wires.push([...(s.from || prev), s.id, into]);
        prev = [s.id, s.out || 'out'];
    }
    return { nodes, wires, input: ['shift', 'in'], text };
}

export const DECODER_INSIDES = {
    'rtty-decoder': (p) => inside(p, [
        { id: 'fsk', type: 'fsk-detector', params: { shiftHz: p.shiftHz, baud: p.baud, invert: p.invert } },
        { id: 'uart', type: 'uart', params: { baud: p.baud, dataBits: 5, stopBits: p.stopBits }, out: 'codes' },
        { id: 'ita2', type: 'ita2-decoder', into: 'codes', out: 'text' },
    ], ['ita2', 'text']),
    'psk31-decoder': (p) => {
        const d = inside(p, [
            // About twice the baud each side: the pulse's main lobe, and the
            // filter that keeps the neighbours out of the timing loop.
            { id: 'filter', type: 'lowpass', params: { cutoffHz: 2 * p.baud, transitionHz: Math.max(20, p.baud) } },
            { id: 'sync', type: 'symbol-sync', params: { baud: p.baud } },
            { id: 'slicer', type: 'psk-slicer', params: { mode: 'dbpsk' }, out: 'bits' },
            { id: 'varicode', type: 'varicode-decoder', into: 'bits', out: 'text' },
        ], ['varicode', 'text']);
        if (!p.afc) return d;
        // Auto-tune: a squaring frequency lock. Squaring BPSK doubles every
        // phase, which turns its reversals (0 and 180°) into no change at
        // all — what is left is a plain carrier at twice the signal's
        // distance from zero, and the counter measures it. The integrator
        // walks the shift until that is nothing, within the capture range
        // either side of the offset that was set. (The counter reads twice
        // the error, so the gain is halved to match.)
        d.nodes[0].controls = ['frequencyHz'];
        d.nodes.push(
            { id: 'square', type: 'complex-multiply', params: {} },
            { id: 'afc', type: 'frequency-counter', params: { gateSec: 0.1 } },
            {
                id: 'tune',
                type: 'integrator',
                params: {
                    gain: -0.2, initial: -p.offsetHz,
                    min: -p.offsetHz - p.afcRangeHz, max: -p.offsetHz + p.afcRangeHz,
                },
            },
        );
        d.wires.push(
            ['filter', 'out', 'square', 'a'], ['filter', 'out', 'square', 'b'],
            ['square', 'out', 'afc', 'in'], ['afc', 'hz', 'tune', 'in'],
            ['tune', 'out', 'shift', 'set:frequencyHz'],
        );
        return d;
    },
    'cw-decoder': (p) => inside(p, [
        { id: 'ook', type: 'ook-detector', params: { bandwidthHz: p.bandwidthHz }, out: 'key' },
        { id: 'morse', type: 'morse-decoder', params: { wpm: p.wpm }, into: 'key', out: 'text' },
    ], ['morse', 'text']),
    'navtex-decoder': (p) => inside(p, [
        { id: 'fsk', type: 'fsk-detector', params: { shiftHz: 170, baud: 100, invert: p.invert } },
        { id: 'sync', type: 'bit-sync', params: { baud: 100 }, out: 'bits' },
        { id: 'sitor', type: 'sitor-decoder', into: 'bits', out: 'text' },
    ], ['sitor', 'text']),
};

/** A one-block decoder, running its inside with a Runtime of its own. */
function decoder(type) {
    return () => {
        let rt = null;
        let rate = 0;
        let inner = null;
        let chars = 0;
        const build = (p, r) => {
            const d = DECODER_INSIDES[type](p);
            const graph = parseGraph({ v: GRAPH_VERSION, nodes: [{ id: '__in', type: 'iq-in' }, ...d.nodes], wires: [['__in', 'out', ...d.input], ...d.wires] }).graph;
            if (!rt || r !== rate) rt = new Runtime(graph, r);
            else rt.setGraph(graph);
            rate = r;
            inner = d;
        };
        let offset = null;
        return {
            configure(p, r) {
                build(p, r);
                // Moved by hand: the lock starts again from there, rather
                // than carrying on from wherever it had pulled the old one.
                if (offset !== null && p.offsetHz !== offset) rt.command('tune', 'reset');
                offset = p.offsetHz;
            },
            reset() { if (rt) rt.reset(); },
            latency() {
                const l = rt && rt.latencyOf(inner.text[0]);
                return l ? l.total * rate : 0;
            },
            read() {
                // Where an auto-tuning decoder has pulled itself to, as an
                // offset like the one set.
                const d = rt && rt.driven().shift;
                return { ok: !!rt && rt.ok, chars, tunedHz: d ? -d.frequencyHz : null };
            },
            process(ins, outs, n) {
                if (!rt) return 0;
                rt.process({ i: ins[0].re, q: ins[0].im, frames: n, rate });
                const node = rt.nodes.get(inner.text[0]);
                const at = node ? node.type.outputs.findIndex((o) => o.name === inner.text[1]) : -1;
                if (at >= 0) {
                    for (const m of node.outs[at].list) {
                        outs[0].list.push(m);
                        if (m.text) chars += m.text.length;
                    }
                }
                return 0;
            },
        };
    };
}
const base = (type, label, summary, params) => ({
    type,
    label,
    category: 'Radio',
    summary,
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [{ name: 'text', kind: MESSAGE }],
    params: { offsetHz: OFFSET, ...params },
    create: decoder(type),
});

export const RttyDecoderBlock = base('rtty-decoder', 'RTTY decoder',
    'Radioteletype to text, in one block — 45.45 baud and 170 Hz for amateurs. Expand it to see the modem.', {
        shiftHz: { kind: 'number', label: 'Shift', unit: 'Hz', default: 170, min: 10, max: 2000, step: 1, control: false },
        baud: { kind: 'number', label: 'Baud', default: 45.45, min: 10, max: 300, step: 0.01, control: false },
        stopBits: { kind: 'choice', label: 'Stop bits', default: 1.5, options: [1, 1.5, 2].map((v) => ({ value: v, label: String(v) })) },
        invert: { kind: 'bool', label: 'Invert', default: false },
    });

export const Psk31DecoderBlock = base('psk31-decoder', 'PSK31 decoder',
    'PSK31 (or 63, 125) to text, in one block. Put the offset near the signal and auto-tune pulls it in. Expand it to see the modem.', {
        baud: { kind: 'choice', label: 'Speed', default: 31.25, options: [31.25, 62.5, 125].map((v) => ({ value: v, label: `PSK${Math.round(v)}` })) },
        afc: { kind: 'bool', label: 'Auto-tune', default: true },
        afcRangeHz: { kind: 'number', label: 'Auto-tune range', unit: 'Hz', default: 30, min: 2, max: 100, step: 1, control: false },
    });

export const CwDecoderBlock = base('cw-decoder', 'CW decoder',
    'Morse to text, in one block, following the sender’s speed. Expand it to see inside.', {
        bandwidthHz: { kind: 'number', label: 'Bandwidth', unit: 'Hz', default: 100, min: 10, max: 1000, step: 5, control: false },
        wpm: { kind: 'number', label: 'Speed (0 = follow)', unit: 'wpm', default: 0, min: 0, max: 60, step: 1 },
    });

export const NavtexDecoderBlock = base('navtex-decoder', 'NAVTEX decoder',
    'NAVTEX (SITOR-B) to text, with its error correction. 518 kHz, or 490 and 4209.5. Expand it to see inside.', {
        invert: { kind: 'bool', label: 'Invert', default: false },
    });
