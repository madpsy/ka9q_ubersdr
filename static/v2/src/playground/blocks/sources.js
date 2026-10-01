// Where a graph's samples come from.

import { COMPLEX, MESSAGE } from '../block.js';
import { SNR_BANDWIDTH_HZ, TEST_MESSAGES, TX_MODES, Transmitter } from '../transmit.js';

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

// The most harmonics a shaped tone is built from. Each is a complex multiply a
// sample, so this caps the cost at the widest streams; a low tone in a wide one
// is slightly rounder than ideal, which no one will hear.
const MAX_HARMONICS = 64;

export const WAVEFORMS = [
    { value: 'sine', label: 'Sine' },
    { value: 'square', label: 'Square' },
    { value: 'triangle', label: 'Triangle' },
    { value: 'sawtooth', label: 'Sawtooth' },
];

/**
 * A waveform's Fourier coefficients, harmonic k at index k: the tone is
 * Σ c_k e^{jkφ}. Taking only the positive harmonics makes it analytic — one
 * line per harmonic on the IQ spectrum, nothing mirrored below the centre —
 * and its real part is the waveform itself, so a Real part block after the
 * generator gives the textbook shape. Built from harmonics rather than drawn
 * sample by sample, it is band-limited: nothing aliases.
 *
 * Square and triangle are in cosine phase, like the sine (whose real part is a
 * cosine): at their peak at φ = 0. The sawtooth rises through zero there.
 */
function harmonics(waveform) {
    const re = new Float64Array(MAX_HARMONICS + 1);
    const im = new Float64Array(MAX_HARMONICS + 1);
    for (let k = 1; k <= MAX_HARMONICS; k++) {
        const odd = k % 2 === 1;
        switch (waveform) {
            case 'square':
                if (odd) re[k] = (4 / (Math.PI * k)) * (((k - 1) / 2) % 2 ? -1 : 1);
                break;
            case 'triangle':
                if (odd) re[k] = 8 / (Math.PI * Math.PI * k * k);
                break;
            case 'sawtooth':
                // (2/πk)(−1)^(k+1) sin kφ, whose analytic form is −j times it.
                im[k] = -(2 / (Math.PI * k)) * (odd ? 1 : -1);
                break;
            default:
                if (k === 1) re[k] = 1;
        }
    }
    return { re, im };
}

/**
 * A test signal on the stream's clock: a tone at a chosen offset — a sine or
 * one of the classic shapes, with a second tone beside it if wanted — and
 * noise under them. For trying a graph without a signal on the band, or with
 * no receiver at all; two tones for the classic two-tone test.
 *
 * Its zero is nowhere on the air unless given a centre frequency, as a
 * player's file is; then the spectra and everything downstream name the tones
 * by their frequencies, and a demodulator after it tunes in real hertz.
 */
export const SignalBlock = {
    type: 'signal',
    label: 'Signal generator',
    category: 'Sources',
    summary: 'One or two tones — sine, square, triangle or sawtooth — at an offset or on the air, with optional noise.',
    inputs: [],
    outputs: [{ name: 'out', kind: COMPLEX }],
    params: {
        centreHz: { kind: 'number', label: 'Centre frequency', unit: 'Hz', default: 0, min: 0, max: 100000000000, step: 1, control: false },
        waveform: { kind: 'choice', label: 'Waveform', default: 'sine', options: WAVEFORMS },
        frequencyHz: { kind: 'number', label: 'Offset', unit: 'Hz', default: 1000, min: -192000, max: 192000, step: 10, live: true },
        amplitude: { kind: 'number', label: 'Amplitude', default: 0.1, min: 0, max: 1, step: 0.001, live: true },
        tone2: { kind: 'bool', label: 'Second tone', default: false },
        frequency2Hz: { kind: 'number', label: 'Second offset', unit: 'Hz', default: 1900, min: -192000, max: 192000, step: 10, live: true, showIf: (p) => p.tone2 },
        amplitude2: { kind: 'number', label: 'Second amplitude', default: 0.1, min: 0, max: 1, step: 0.001, live: true, showIf: (p) => p.tone2 },
        noise: { kind: 'number', label: 'Noise', default: 0, min: 0, max: 1, step: 0.0001, live: true },
    },
    create() {
        const phases = [0, 0];
        let p = {};
        let rate = 12000;
        let shape = harmonics('sine');
        let shapeOf = 'sine';
        // A small fixed-seed generator, so a graph run twice runs the same.
        let seed = 1;
        const rnd = () => {
            seed = (seed + 0x6d2b79f5) >>> 0;
            let x = seed;
            x = Math.imul(x ^ (x >>> 15), x | 1);
            x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
            return ((x ^ (x >>> 14)) >>> 0) / 4294967296 - 0.5;
        };
        // Adds one tone into the output, from phase `phases[t]`. The
        // frequency is read here, not at configure, as a control may be
        // moving it.
        const tone = (out, n, t, hz, a, add) => {
            const step = (2 * Math.PI * hz) / rate;
            // Harmonics above Nyquist would alias, so the shape is cut there.
            const K = shapeOf === 'sine' || !hz
                ? 1
                : Math.max(1, Math.min(MAX_HARMONICS, Math.floor(rate / 2 / Math.abs(hz))));
            let phase = phases[t];
            for (let k = 0; k < n; k++) {
                const c = Math.cos(phase);
                const s = Math.sin(phase);
                let re = 0;
                let im = 0;
                if (K === 1) {
                    re = shape.re[1] * c - shape.im[1] * s;
                    im = shape.re[1] * s + shape.im[1] * c;
                } else {
                    // e^{jkφ} by repeated multiplication, from e^{jφ}.
                    let zr = c;
                    let zi = s;
                    for (let h = 1; h <= K; h++) {
                        const cr = shape.re[h];
                        const ci = shape.im[h];
                        if (cr || ci) {
                            re += cr * zr - ci * zi;
                            im += cr * zi + ci * zr;
                        }
                        const nr = zr * c - zi * s;
                        zi = zr * s + zi * c;
                        zr = nr;
                    }
                }
                if (add) {
                    out.re[k] += a * re;
                    out.im[k] += a * im;
                } else {
                    out.re[k] = a * re;
                    out.im[k] = a * im;
                }
                phase += step;
            }
            phases[t] = phase % (2 * Math.PI);
        };
        return {
            configure(params, r) {
                p = params;
                rate = r;
                if (params.waveform !== shapeOf) {
                    shapeOf = params.waveform;
                    shape = harmonics(shapeOf);
                }
            },
            reset() { phases[0] = 0; phases[1] = 0; seed = 1; },
            process(ins, outs, n) {
                const out = outs[0];
                tone(out, n, 0, p.frequencyHz, p.amplitude, false);
                if (p.tone2) tone(out, n, 1, p.frequency2Hz, p.amplitude2, true);
                const g = p.noise * 2;
                if (g) {
                    for (let k = 0; k < n; k++) {
                        out.re[k] += g * rnd();
                        out.im[k] += g * rnd();
                    }
                }
                return n;
            },
        };
    },
};

const isMode = (...modes) => (p) => modes.includes(p.mode);

/**
 * A transmitter for the decoders to decode: CW, RTTY, PSK or NAVTEX, sending a
 * message of the operator's or the mode's own test message, at the speed,
 * shift, level and signal-to-noise asked for (transmit.js). The settings shown
 * are the mode's.
 *
 * Like the signal generator, its zero is on the air only if given a centre
 * frequency.
 */
export const DataTransmitterBlock = {
    type: 'data-tx',
    label: 'Data transmitter',
    category: 'Sources',
    summary: 'Sends CW, RTTY, PSK or NAVTEX — a test message or your own — at the speed, level and noise you choose. For trying the decoders.',
    inputs: [],
    // `sent` is the text as it goes out, each character as its last symbol
    // ends: a console on it beside one on a decoder shows the two side by side.
    outputs: [{ name: 'out', kind: COMPLEX }, { name: 'sent', kind: MESSAGE }],
    params: {
        mode: { kind: 'choice', label: 'Mode', default: 'rtty', options: TX_MODES },
        text: {
            kind: 'text', label: 'Message', default: '', max: 2000, multiline: true, live: true,
            placeholder: (p) => TEST_MESSAGES[p.mode] || '',
        },
        repeat: { kind: 'bool', label: 'Repeat', default: true },
        gapSec: { kind: 'number', label: 'Gap between repeats', unit: 's', default: 2, min: 0, max: 60, step: 0.5, live: true, showIf: (p) => p.repeat },
        offsetHz: { kind: 'number', label: 'Offset', unit: 'Hz', default: 1000, min: -192000, max: 192000, step: 10, live: true },
        centreHz: { kind: 'number', label: 'Centre frequency', unit: 'Hz', default: 0, min: 0, max: 100000000000, step: 1, control: false },
        levelDb: { kind: 'number', label: 'Level', unit: 'dBFS', default: -20, min: -100, max: 0, step: 1, live: true },
        noise: { kind: 'bool', label: 'Noise', default: false },
        snrDb: { kind: 'number', label: `SNR (in ${SNR_BANDWIDTH_HZ / 1000} kHz)`, unit: 'dB', default: 10, min: -30, max: 60, step: 1, live: true, showIf: (p) => p.noise },
        // CW
        wpm: { kind: 'number', label: 'Speed', unit: 'wpm', default: 20, min: 5, max: 60, step: 1, showIf: isMode('cw') },
        riseMs: { kind: 'number', label: 'Key rise time', unit: 'ms', default: 5, min: 0.5, max: 20, step: 0.5, showIf: isMode('cw') },
        // RTTY
        baud: { kind: 'number', label: 'Baud', default: 45.45, min: 10, max: 300, step: 0.01, showIf: isMode('rtty') },
        shiftHz: { kind: 'number', label: 'Shift', unit: 'Hz', default: 170, min: 10, max: 2000, step: 1, showIf: isMode('rtty') },
        stopBits: { kind: 'choice', label: 'Stop bits', default: 1.5, options: [1, 1.5, 2].map((v) => ({ value: v, label: String(v) })), showIf: isMode('rtty') },
        // PSK
        pskBaud: { kind: 'choice', label: 'Speed', default: 31.25, options: [31.25, 62.5, 125].map((v) => ({ value: v, label: `PSK${Math.round(v)}` })), showIf: isMode('psk') },
        // RTTY and NAVTEX
        invert: { kind: 'bool', label: 'Invert (mark below space)', default: false, showIf: isMode('rtty', 'navtex') },
    },
    create() {
        const tx = new Transmitter();
        return {
            configure(p, r) { tx.configure(p, r); },
            reset() { tx.reset(); },
            command(name) { if (name === 'restart') tx.restart(); },
            read() { return tx.status(); },
            process(ins, outs, n) {
                const text = tx.process(outs[0].re, outs[0].im, n);
                if (text && outs[1]) outs[1].list.push({ type: 'text', text });
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
