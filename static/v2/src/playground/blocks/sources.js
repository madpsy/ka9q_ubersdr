// Where a graph's samples come from.

import { COMPLEX } from '../block.js';

/**
 * The receiver's IQ stream, as it arrives: I and Q at the stream's own rate.
 * Every graph that listens to the receiver starts here.
 */
export const IqInBlock = {
    type: 'iq-in',
    label: 'IQ stream',
    category: 'Sources',
    summary: 'The receiver’s quadrature stream, centred on the dial.',
    inputs: [],
    outputs: [{ name: 'out', kind: COMPLEX }],
    // The receiver's IQ width this graph is built for. Not used here — the
    // stream arrives at whatever rate the receiver sends — but kept in the
    // graph so a shared or saved one says what it needs, and the playground
    // switches the receiver to it (see PlaygroundWatch). The inspector works it
    // with the receiver's own width buttons rather than as an ordinary setting.
    params: {
        width: {
            kind: 'choice',
            label: 'IQ width',
            default: 'iq',
            control: false,
            options: [
                { value: 'iq', label: '12 kHz' },
                { value: 'iq48', label: '48 kHz' },
                { value: 'iq96', label: '96 kHz' },
                { value: 'iq192', label: '192 kHz' },
                { value: 'iq384', label: '384 kHz' },
            ],
        },
    },
    create() {
        return {
            configure() {},
            reset() {},
            process(ins, outs, n, stream) {
                const out = outs[0];
                if (!stream || !stream.i) {
                    out.re.fill(0, 0, n);
                    out.im.fill(0, 0, n);
                    return n;
                }
                // Single precision in, doubles out: the same values, widened.
                for (let k = 0; k < n; k++) {
                    out.re[k] = stream.i[k];
                    out.im[k] = stream.q[k];
                }
                return n;
            },
        };
    },
};

/**
 * A test signal on the stream's clock: a tone at a chosen offset, with or
 * without noise under it. For trying a graph without a signal on the band, or
 * with no receiver at all.
 */
export const SignalBlock = {
    type: 'signal',
    label: 'Signal generator',
    category: 'Sources',
    summary: 'A complex tone at an offset, with optional noise.',
    inputs: [],
    outputs: [{ name: 'out', kind: COMPLEX }],
    params: {
        frequencyHz: { kind: 'number', label: 'Offset', unit: 'Hz', default: 1000, min: -192000, max: 192000, step: 10, live: true },
        amplitude: { kind: 'number', label: 'Amplitude', default: 0.1, min: 0, max: 1, step: 0.001, live: true },
        noise: { kind: 'number', label: 'Noise', default: 0, min: 0, max: 1, step: 0.0001, live: true },
    },
    create() {
        let phase = 0;
        let p = {};
        let rate = 12000;
        // A small fixed-seed generator, so a graph run twice runs the same.
        let seed = 1;
        const rnd = () => {
            seed = (seed + 0x6d2b79f5) >>> 0;
            let x = seed;
            x = Math.imul(x ^ (x >>> 15), x | 1);
            x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
            return ((x ^ (x >>> 14)) >>> 0) / 4294967296 - 0.5;
        };
        return {
            configure(params, r) { p = params; rate = r; },
            reset() { phase = 0; seed = 1; },
            process(ins, outs, n) {
                const out = outs[0];
                const step = (2 * Math.PI * p.frequencyHz) / rate;
                const a = p.amplitude;
                const g = p.noise * 2;
                for (let k = 0; k < n; k++) {
                    out.re[k] = a * Math.cos(phase) + (g ? g * rnd() : 0);
                    out.im[k] = a * Math.sin(phase) + (g ? g * rnd() : 0);
                    phase += step;
                }
                phase %= 2 * Math.PI;
                return n;
            },
        };
    },
};

/**
 * An IQ recording, played into the graph as though it were the receiver.
 *
 * The file is loaded by the page (wavfile.js) and handed to the block whole;
 * the graph runs at the file's own rate from here on, so a 48 kHz recording
 * is a 48 kHz stream whatever the receiver is doing — or whether there is a
 * receiver at all. A graph with a player and no IQ stream runs on its own
 * clock: build, debug and compare against the same seconds of signal as many
 * times as it takes.
 *
 * The file itself is not part of the graph — a link to a graph does not carry
 * a recording — so `fileName` and `rateHz` are kept to say what it was, and
 * the player plays silence until one is loaded.
 */
export const IqPlayerBlock = {
    type: 'iq-player',
    label: 'IQ player',
    category: 'Sources',
    summary: 'Plays an IQ WAV file into the graph — no receiver needed.',
    inputs: [],
    outputs: [{ name: 'out', kind: COMPLEX }],
    params: {
        rateHz: { kind: 'number', label: 'File rate', unit: 'Hz', default: 0, min: 0, max: 10000000, step: 1, control: false },
        centreHz: { kind: 'number', label: 'Centre frequency', unit: 'Hz', default: 0, min: 0, max: 100000000000, step: 1, control: false },
        loop: { kind: 'bool', label: 'Loop', default: true },
        fileName: { kind: 'text', label: 'File', default: '', max: 200 },
    },
    rate: (inRate, p) => (p.rateHz > 0 ? p.rateHz : inRate),
    create() {
        let file = null;
        let pos = 0;
        let carry = 0;
        let rate = 0;
        let loop = true;
        let ended = false;
        return {
            configure(p, r) { rate = p.rateHz > 0 ? p.rateHz : r; loop = p.loop; },
            reset() { pos = 0; carry = 0; ended = false; },
            /** The file's samples, as decodeWav gives them. */
            load(data) {
                file = data && data.i ? data : null;
                pos = 0;
                carry = 0;
                ended = false;
            },
            command(name) {
                if (name === 'restart') { pos = 0; ended = false; }
                if (name === 'unload') { file = null; pos = 0; }
            },
            /**
             * How many samples a packet of the clock's stands for at the
             * file's rate — the remainder carried, so nothing drifts.
             */
            framesFor(frames, clockRate) {
                if (!(clockRate > 0)) return frames;
                const exact = (frames * rate) / clockRate + carry;
                const n = Math.floor(exact);
                carry = exact - n;
                return n;
            },
            read() {
                return {
                    loaded: !!file,
                    position: file ? pos / file.rate : 0,
                    duration: file ? file.frames / file.rate : 0,
                    ended,
                };
            },
            process(ins, outs, n) {
                const out = outs[0];
                let k = 0;
                while (k < n) {
                    if (!file || !file.frames || ended) {
                        out.re.fill(0, k, n);
                        out.im.fill(0, k, n);
                        break;
                    }
                    const take = Math.min(n - k, file.frames - pos);
                    for (let j = 0; j < take; j++) {
                        out.re[k + j] = file.i[pos + j];
                        out.im[k + j] = file.q[pos + j];
                    }
                    k += take;
                    pos += take;
                    if (pos >= file.frames) {
                        if (loop) pos = 0;
                        else ended = true;
                    }
                }
                return n;
            },
        };
    },
};
