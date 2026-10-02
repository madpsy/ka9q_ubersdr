// One-block decoders: RTTY, PSK31, CW, NAVTEX and the MFSK family (Olivia and
// Contestia, MFSK16, DominoEX, THOR) as a single block each — IQ in, text
// out — for anyone who wants the text rather than the modem.
//
// Each is a small graph of the digital blocks run inside the block by its own
// Runtime, so it is those blocks, stage for stage, and Expand (playground/
// expand.js) lays exactly that graph out on the canvas in its place: the same
// text, and every stage to probe.
//
// Every one takes the signal anywhere in its input — `offsetHz` says where,
// from the input's zero — and shifts it to zero itself.

import { COMPLEX, CONTROL, MESSAGE, REAL, emitControl } from '../block.js';
import { FaxRasterBlock, wefaxFrontEndStages } from './fax.js';
import { SstvDemodBlock, SstvRasterBlock } from './sstvstages.js';
// A cycle — runtime.js reaches every block, these included — which is safe
// because neither is used until a decoder is configured, long after every
// module has loaded.
import { GRAPH_VERSION, parseGraph } from '../graph.js';
import { Runtime } from '../runtime.js';

// The MFSK family's speeds, as fldigi defines them: its sample rate and
// symbol length in samples (so the baud), and for MFSK the interleaver's
// depth (mfsk::mfsk) and for DominoEX and THOR whether the tones are spaced
// at twice the baud (dominoex::dominoex, thor::thor — `doublespaced`).
const MFSK_MODES = {
    mfsk16: { label: 'MFSK16', rate: 8000, symlen: 512, depth: 10 },
    mfsk32: { label: 'MFSK32', rate: 8000, symlen: 256, depth: 10 },
    mfsk64: { label: 'MFSK64', rate: 8000, symlen: 128, depth: 10 },
    mfsk128: { label: 'MFSK128', rate: 8000, symlen: 64, depth: 20 },
    mfsk11: { label: 'MFSK11', rate: 11025, symlen: 1024, depth: 10 },
    mfsk22: { label: 'MFSK22', rate: 11025, symlen: 512, depth: 10 },
};
const IFK_MODES = {
    4: { rate: 8000, symlen: 2048, double: 2 },
    5: { rate: 11025, symlen: 2048, double: 2 },
    8: { rate: 8000, symlen: 1024, double: 2 },
    11: { rate: 11025, symlen: 1024, double: 1 },
    16: { rate: 8000, symlen: 512, double: 1 },
    22: { rate: 11025, symlen: 512, double: 1 },
};
// Points per tone for IFK+, fldigi's `paths`: a mistuned tone still lands
// within a tenth of a tone of one.
const IFK_POINTS = 5;
/** The tone detector for DominoEX or THOR: 18 tones, and half as many again each side (fldigi's `extones`), with no AFC. */
const ifkDetector = (m) => ({
    tones: 18, spacingHz: (m.rate * m.double) / m.symlen, baud: m.rate / m.symlen,
    oversample: IFK_POINTS, margin: 9, pulse: 'rect', afc: false,
});

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

/**
 * An audio decoder's inside (SSTV, WEFAX): no shift — audio is already where
 * it is — and any number of outputs, `outputs` naming the [id, port] each of
 * the block's outputs comes from. `reading` is the stage whose reading the
 * block's card shows.
 */
export function insideAudio(stages, outputs, reading) {
    const nodes = [];
    const wires = [];
    let prev = null;
    for (const s of stages) {
        nodes.push({ id: s.id, type: s.type, params: s.params || {} });
        const into = s.into || 'in';
        const from = s.from || prev;
        if (from) wires.push([...from, s.id, into]);
        prev = [s.id, s.out || 'out'];
    }
    for (const w of stages.flatMap((s) => s.also || [])) wires.push(w);
    return { nodes, wires, input: [stages[0].id, stages[0].into || 'in'], outputs, text: outputs.text, reading, audio: true };
}

/** The [id, port] each of a decoder's outputs comes from: `outputs`, or the one text output. */
export const insideOutputs = (d) => d.outputs || { text: d.text };

// The WEFAX block's filter choice, as the front end's low-pass cutoff: 800 Hz
// is better in noise, 1200 Hz sharper on a clean signal (blocks/fax.js).
const FAX_CUTOFF = { narrow: 800, middle: 1000, wide: 1200 };
const FAX_RASTER_KEYS = Object.keys(FaxRasterBlock.params);

export const DECODER_INSIDES = {
    // SSTV: slowrx's demodulator — frequency and sync strength — and the
    // raster that reads the VIS header, draws the lines and the FSK ID.
    'sstv': (p) => insideAudio([
        { id: 'demod', type: 'sstv-demod', params: { adaptive: p.adaptive }, into: 'audio', out: 'hz' },
        { id: 'raster', type: 'sstv-raster', into: 'hz', params: { mode: p.mode, slant: p.slant }, also: [['demod', 'sync', 'raster', 'sync']] },
    ], Object.fromEntries(SstvRasterBlock.outputs.map((o) => [o.name, ['raster', o.name]])), 'raster'),
    // WEFAX: the audio made analytic, the carrier shifted to zero, the
    // channel low-passed and discriminated into a level, and the raster.
    'wefax': (p) => insideAudio([
        ...wefaxFrontEndStages({ carrier: p.carrier, deviation: p.deviation, cutoffHz: FAX_CUTOFF[p.bandwidth] || 1000 }),
        { id: 'raster', type: 'fax-raster', into: 'level', params: Object.fromEntries(FAX_RASTER_KEYS.map((k) => [k, p[k]])) },
    ], { images: ['raster', 'images'], text: ['raster', 'text'] }, 'raster'),
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
            ...(p.psk === 'qpsk'
                // QPSK31: the phase steps are the code's pairs, and the
                // Viterbi decoder turns them back into Varicode bits.
                ? [
                    { id: 'slicer', type: 'psk-slicer', params: { mode: 'dqpsk' }, out: 'bits' },
                    { id: 'fec', type: 'viterbi', params: { code: 'qpsk31', pairing: 0 }, into: 'bits', out: 'bits' },
                ]
                : [{ id: 'slicer', type: 'psk-slicer', params: { mode: 'dbpsk' }, out: 'bits' }]),
            { id: 'varicode', type: 'varicode-decoder', into: 'bits', out: 'text' },
        ], ['varicode', 'text']);
        if (!p.afc) return d;
        const qpsk = p.psk === 'qpsk';
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
            // QPSK needs the fourth power — squared again — to lose its
            // four phases, and reads four times the error.
            ...(qpsk ? [{ id: 'square2', type: 'complex-multiply', params: {} }] : []),
            { id: 'afc', type: 'frequency-counter', params: { gateSec: 0.1 } },
            {
                id: 'tune',
                type: 'integrator',
                params: {
                    gain: qpsk ? -0.1 : -0.2, initial: -p.offsetHz,
                    min: -p.offsetHz - p.afcRangeHz, max: -p.offsetHz + p.afcRangeHz,
                },
            },
        );
        d.wires.push(
            ['filter', 'out', 'square', 'a'], ['filter', 'out', 'square', 'b'],
            ...(qpsk
                ? [['square', 'out', 'square2', 'a'], ['square', 'out', 'square2', 'b'], ['square2', 'out', 'afc', 'in']]
                : [['square', 'out', 'afc', 'in']]),
            ['afc', 'hz', 'tune', 'in'],
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
    // The MFSK family (blocks/mfsk.js): one tone detector, set as each mode
    // needs it, and the stages after it that make the mode what it is.
    'olivia-decoder': (p) => {
        // An Olivia symbol lasts as long as one over its tone spacing.
        const spacing = p.bandwidth / p.tones;
        return inside(p, [
            {
                id: 'tones', type: 'mfsk-detector', out: 'tones',
                params: { tones: p.tones, spacingHz: spacing, baud: spacing, oversample: 2, margin: p.margin, pulse: 'olivia', afc: false },
            },
            {
                id: 'fec', type: 'olivia-fec', into: 'tones', out: 'text',
                params: { mode: p.mode, tones: p.tones, margin: p.margin, integration: p.integration, threshold: p.threshold },
            },
        ], ['fec', 'text']);
    },
    'mfsk-decoder': (p) => {
        const m = MFSK_MODES[p.mode] || MFSK_MODES.mfsk16;
        const baud = m.rate / m.symlen;
        return inside(p, [
            {
                id: 'tones', type: 'mfsk-detector', out: 'tones',
                params: { tones: 16, spacingHz: baud, baud, oversample: 1, margin: 0, pulse: 'rect', afc: p.afc, afcRangeHz: p.afcRangeHz },
            },
            { id: 'demap', type: 'mfsk-demapper', params: { tones: 16, oversample: 1, margin: 0, gray: true }, into: 'tones', out: 'soft' },
            { id: 'deinterleave', type: 'mfsk-interleaver', params: { direction: 'deinterleave', kind: 'soft', size: 4, depth: m.depth } },
            { id: 'fec', type: 'soft-viterbi', params: { code: 'nasa', pairing: 0 }, into: 'soft', out: 'bits' },
            { id: 'varicode', type: 'mfsk-varicode', into: 'bits', out: 'text' },
        ], ['varicode', 'text']);
    },
    'dominoex-decoder': (p) => {
        const m = IFK_MODES[p.mode] || IFK_MODES['16'];
        return inside(p, [
            { id: 'tones', type: 'mfsk-detector', params: ifkDetector(m), out: 'tones' },
            { id: 'ifk', type: 'ifk-decoder', params: { tones: 18, oversample: IFK_POINTS, margin: 9, soft: false }, into: 'tones', out: 'soft' },
            { id: 'varicode', type: 'dominoex-varicode', into: 'soft', out: 'text' },
        ], ['varicode', 'text']);
    },
    'thor-decoder': (p) => {
        const m = IFK_MODES[p.mode] || IFK_MODES['16'];
        return inside(p, [
            { id: 'tones', type: 'mfsk-detector', params: ifkDetector(m), out: 'tones' },
            { id: 'ifk', type: 'ifk-decoder', params: { tones: 18, oversample: IFK_POINTS, margin: 9, soft: true }, into: 'tones', out: 'soft' },
            { id: 'deinterleave', type: 'mfsk-interleaver', params: { direction: 'deinterleave', kind: 'soft', size: 4, depth: 10 } },
            { id: 'fec', type: 'soft-viterbi', params: { code: 'nasa', pairing: 0 }, into: 'soft', out: 'bits' },
            { id: 'varicode', type: 'mfsk-varicode', params: { secondary: true }, into: 'bits', out: 'text' },
        ], ['varicode', 'text']);
    },
};

/** A one-block decoder, running its inside with a Runtime of its own. */
function decoder(type, outputs = [{ name: 'text', kind: MESSAGE }]) {
    return () => {
        let rt = null;
        let rate = 0;
        let inner = null;
        let chars = 0;
        const build = (p, r) => {
            const d = DECODER_INSIDES[type](p);
            // Audio arrives as the I of the inner stream, and its real part feeds the inside.
            const head = d.audio
                ? { nodes: [{ id: '__in', type: 'iq-in' }, { id: '__re', type: 'real-part' }], wires: [['__in', 'out', '__re', 'in'], ['__re', 'out', ...d.input]] }
                : { nodes: [{ id: '__in', type: 'iq-in' }], wires: [['__in', 'out', ...d.input]] };
            const graph = parseGraph({ v: GRAPH_VERSION, nodes: [...head.nodes, ...d.nodes], wires: [...head.wires, ...d.wires] }).graph;
            if (!rt || r !== rate) rt = new Runtime(graph, r);
            else rt.setGraph(graph);
            rate = r;
            inner = d;
        };
        let offset = null;
        const seen = [];
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
                const first = Object.values(insideOutputs(inner))[0];
                const l = rt && first && rt.latencyOf(first[0]);
                return l ? l.total * rate : 0;
            },
            read() {
                // An audio decoder's card shows its chosen stage's reading.
                if (inner && inner.reading) return { ...(rt ? rt.read(inner.reading) : null), ok: !!rt && rt.ok };
                // Where an auto-tuning decoder has pulled itself to, as an
                // offset like the one set.
                const d = rt && rt.driven().shift;
                return { ok: !!rt && rt.ok, chars, tunedHz: d ? -d.frequencyHz : null };
            },
            activity() {
                const r = inner && inner.reading && rt ? rt.read(inner.reading) : null;
                return r && r.state === 'receiving' ? 1 : 0;
            },
            process(ins, outs, n) {
                if (!rt) return 0;
                rt.process({ i: ins[0].re, q: ins[0].im || new Float64Array(n), frames: n, rate });
                const map = insideOutputs(inner);
                outputs.forEach((o, k) => {
                    const from = map[o.name];
                    const node = from && rt.nodes.get(from[0]);
                    const at = node ? node.type.outputs.findIndex((x) => x.name === from[1]) : -1;
                    if (at < 0 || !outs[k]) return;
                    // A control: passed on when the stage inside sends a new value.
                    if (o.kind === CONTROL) {
                        const src = node.outs[at];
                        if (src.seq !== seen[k] && src.value != null) { seen[k] = src.seq; emitControl(outs[k], src.value); }
                        return;
                    }
                    if (!outs[k].list) return;
                    for (const m of node.outs[at].list) {
                        outs[k].list.push(m);
                        if (m.text) chars += m.text.length;
                    }
                });
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
    'PSK31 (or 63, 125, and QPSK) to text, in one block. Put the offset near the signal and auto-tune pulls it in. Expand it to see the modem.', {
        psk: { kind: 'choice', label: 'Modulation', default: 'bpsk', options: [{ value: 'bpsk', label: 'BPSK' }, { value: 'qpsk', label: 'QPSK (with FEC)' }] },
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

export const OliviaDecoderBlock = base('olivia-decoder', 'Olivia decoder',
    'Olivia (or Contestia) to text, in one block — 8/250 and 8/500 are the usual. It finds the signal within the search margin itself. Expand it to see inside.', {
        mode: { kind: 'choice', label: 'Mode', default: 'olivia', options: [{ value: 'olivia', label: 'Olivia' }, { value: 'contestia', label: 'Contestia' }] },
        tones: { kind: 'choice', label: 'Tones', default: 8, options: [2, 4, 8, 16, 32, 64, 128, 256].map((v) => ({ value: v, label: String(v) })) },
        bandwidth: { kind: 'choice', label: 'Bandwidth', default: 250, options: [125, 250, 500, 1000, 2000].map((v) => ({ value: v, label: `${v} Hz` })) },
        margin: { kind: 'number', label: 'Search margin', unit: 'tones', default: 4, min: 1, max: 16, step: 0.5, control: false },
        integration: { kind: 'number', label: 'Integration', unit: 'blocks', default: 4, min: 2, max: 32, step: 1, control: false },
        threshold: { kind: 'number', label: 'Squelch (S/N)', default: 3.5, min: 0, max: 20, step: 0.1 },
    });

export const MfskDecoderBlock = base('mfsk-decoder', 'MFSK decoder',
    'MFSK16 (or 32, 64, 128, 11, 22) to text, in one block. Put the offset on the signal and AFC trims it. Expand it to see the modem.', {
        mode: { kind: 'choice', label: 'Mode', default: 'mfsk16', options: Object.entries(MFSK_MODES).map(([value, m]) => ({ value, label: m.label })) },
        afc: { kind: 'bool', label: 'AFC', default: true },
        afcRangeHz: { kind: 'number', label: 'AFC range', unit: 'Hz', default: 8, min: 1, max: 100, step: 1, control: false },
    });

const ifkOptions = (name) => Object.keys(IFK_MODES).map((v) => ({ value: v, label: `${name} ${v}` }));

export const DominoexDecoderBlock = base('dominoex-decoder', 'DominoEX decoder',
    'DominoEX to text, in one block — no FEC, and no fine tuning needed: it reads the steps between tones. Expand it to see inside.', {
        mode: { kind: 'choice', label: 'Speed', default: '16', options: ifkOptions('DominoEX') },
    });

export const ThorDecoderBlock = base('thor-decoder', 'THOR decoder',
    'THOR to text, in one block: DominoEX’s keying with an interleaver and a Viterbi decoder behind it. Expand it to see the modem.', {
        mode: { kind: 'choice', label: 'Speed', default: '16', options: ifkOptions('THOR') },
    });

const PICTURE_OUTPUTS = [{ name: 'images', kind: MESSAGE }, { name: 'text', kind: MESSAGE }];

export const WefaxBlock = {
    type: 'wefax',
    label: 'WEFAX',
    category: 'Radio',
    summary: 'Weather fax: charts from the met services’ HF stations, drawn line by line — started by the station’s START tone, lined up by its phasing, ended by its STOP. Feed it USB audio tuned 1.9 kHz below the listed frequency; wire its images to an Image viewer. Expand it to see the demodulator and the raster.',
    inputs: [{ name: 'audio', kind: REAL }],
    outputs: PICTURE_OUTPUTS,
    activity: 'Receiving',
    params: {
        carrier: { kind: 'number', label: 'Centre', unit: 'Hz', default: 1900, min: 500, max: 3000, step: 1, control: false },
        deviation: { kind: 'number', label: 'Deviation', unit: 'Hz', default: 400, min: 100, max: 1000, step: 10, control: false },
        bandwidth: { kind: 'choice', label: 'Filter', default: 'middle', options: [{ value: 'narrow', label: 'Narrow (better in noise)' }, { value: 'middle', label: 'Middle' }, { value: 'wide', label: 'Wide (sharper)' }] },
        ...FaxRasterBlock.params,
    },
    create: decoder('wefax', PICTURE_OUTPUTS),
};

export const SstvBlock = {
    type: 'sstv',
    label: 'SSTV',
    category: 'Radio',
    summary: 'Slow-scan television: pictures in colour, drawn line by line — the mode read from the VIS header (Martin, Scottie, Robot, PD, Wraase, Pasokon), the slant straightened when each is done, and the sender’s callsign from its FSK ID. Feed it USB audio; wire its images to an Image viewer. Expand it to see the demodulator and the raster.',
    inputs: [{ name: 'audio', kind: REAL }],
    outputs: SstvRasterBlock.outputs,
    activity: 'Receiving',
    params: { ...SstvRasterBlock.params, ...SstvDemodBlock.params },
    create: decoder('sstv', SstvRasterBlock.outputs),
};
