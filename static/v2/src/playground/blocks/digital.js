// Digital modes: from a signal to bits, and from bits to text.
//
// Built as the stages a modem is made of rather than one box per mode, so the
// same parts make several — and each stage can be probed, which is the point
// of building one here: the FSK detector's output on a scope is RTTY's eye,
// the symbol sync's output on a constellation is PSK31's two points.
//
//   RTTY     FSK detector → UART → ITA2 decoder → console
//   PSK31    Costas loop → symbol sync → PSK slicer → Varicode decoder → console
//   CW       OOK detector → Morse decoder → console
//
// Everything takes a complex signal with the carrier (or the FSK pair's
// centre) near zero — shift there first, or use a Demodulator's offset — and
// does its own narrowing, so it works at any stream rate.

import { BITS, COMPLEX, CONTROL, MESSAGE, REAL, emitControl } from '../block.js';
import { ComplexFir, designLowpass } from '../../lib/dsp/fir.js';
import { Decimator } from '../../lib/dsp/decimator.js';
import { Nco } from '../../lib/dsp/nco.js';
import { Ita2Decoder, SitorDecoder, VaricodeDecoder, ccirValid, morseChar } from '../codes.js';
import { alignText, normaliseText } from '../textdiff.js';
import { KEYER_DEFAULTS as KD, Keyer, WPM_MAX, WPM_MIN } from '../keyer.js';

/**
 * A complex signal brought down to the lowest rate at least `need` Hz, by a
 * whole factor — the narrow filters after it then cost a fraction of what
 * they would at the stream's rate. Returns the decimated pair and its rate.
 */
class Narrower {
    constructor() {
        this.dec = new Decimator();
        this.key = '';
        this.D = 1;
        this.I = new Float32Array(0);
        this.Q = new Float32Array(0);
    }

    configure(rate, need, passHz) {
        const D = Math.max(1, Math.floor(rate / Math.max(need, 2 * passHz + 200)));
        const key = `${rate}/${D}/${passHz}`;
        if (key !== this.key) {
            this.key = key;
            this.D = D;
            if (D > 1) {
                const stop = rate / D - passHz;
                this.dec.setFilter(designLowpass((passHz + stop) / 2, rate, stop - passHz), D);
                this.dec.frequencyHz = 0;
            }
        }
        return rate / D;
    }

    reset() { this.dec.reset(); }

    process(re, im, n, rate) {
        if (this.D === 1) return { I: re, Q: im, n };
        const max = Math.ceil(n / this.D) + 1;
        if (this.I.length < max) {
            this.I = new Float32Array(max);
            this.Q = new Float32Array(max);
        }
        const m = this.dec.process(re, im, this.I, this.Q, n, rate);
        return { I: this.I, Q: this.Q, n: m };
    }
}

// ── FSK ─────────────────────────────────────────────────────────────────────

/** The rate an FSK detector narrows to, for a stream rate and its settings. */
function fskRate(inRate, p) {
    const pass = p.shiftHz / 2 + 2 * p.baud;
    const D = Math.max(1, Math.floor(inRate / Math.max(1000, 2 * pass + 200)));
    return inRate / D;
}

/**
 * Two-tone FSK to a soft bit: +1 mark, −1 space, and between when unsure.
 *
 * Mark and space are separated by a narrow filter each, centred ±shift/2 from
 * zero — mark the higher, as RTTY defines it on the air. The output is
 * (mark − space) / (mark + space): the difference of the two tones' power, but
 * against their sum, so a fade that takes both down leaves the decision where
 * it was, and one that takes one tone down (selective fading, which HF does)
 * still leaves the other deciding. Put a scope on it and it is the signal's
 * eye.
 */
export const FskDetectorBlock = {
    type: 'fsk-detector',
    label: 'FSK detector',
    category: 'Digital',
    summary: 'Two tones to a soft bit, +1 mark and −1 space — RTTY, NAVTEX, any two-tone FSK. Centre it on zero first.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [{ name: 'out', kind: REAL, audio: false }],
    params: {
        shiftHz: { kind: 'number', label: 'Shift', unit: 'Hz', default: 170, min: 10, max: 2000, step: 1, control: false },
        baud: { kind: 'number', label: 'Baud', default: 45.45, min: 1, max: 600, step: 0.01, control: false },
        invert: { kind: 'bool', label: 'Invert (mark below space)', default: false },
    },
    rate: fskRate,
    maxOut: (n) => n + 1,
    create() {
        const narrow = new Narrower();
        const mix = [new Nco(), new Nco()];
        const fir = [new ComplexFir(), new ComplexFir()];
        let bufs = null;
        let p = {};
        let rate = 12000;
        let inRate = 12000;
        let key = '';
        let mark = 0;
        let space = 0;
        return {
            configure(params, r) {
                p = params;
                inRate = r;
                const pass = p.shiftHz / 2 + 2 * p.baud;
                rate = narrow.configure(r, 1000, pass);
                const k = `${rate}/${p.shiftHz}/${p.baud}`;
                if (k !== key) {
                    key = k;
                    // Each tone's filter passes most of a bit's spectrum and
                    // has rolled off well before the other tone.
                    const cutoff = Math.min(p.baud * 0.75, p.shiftHz * 0.4);
                    const taps = designLowpass(cutoff, rate, Math.max(10, Math.min(p.shiftHz * 0.5, cutoff)));
                    fir[0].setTaps(taps);
                    fir[1].setTaps(taps);
                }
                // Mark to zero, and space to zero.
                mix[0].frequencyHz = -p.shiftHz / 2;
                mix[1].frequencyHz = p.shiftHz / 2;
            },
            reset() { narrow.reset(); fir.forEach((f) => f.reset()); mix.forEach((m) => m.reset()); },
            latency() { return (Math.max(0, (fir[0].n - 1) / 2)) * (inRate / rate); },
            read() {
                const db = (v) => (v > 0 ? 10 * Math.log10(v) : null);
                return { markDb: db(mark), spaceDb: db(space) };
            },
            process(ins, outs, n) {
                const x = narrow.process(ins[0].re, ins[0].im, n, inRate);
                const m = x.n;
                if (!bufs || bufs.mi.length < m) {
                    const z = () => new Float64Array(Math.max(m, 256));
                    bufs = { mi: z(), mq: z(), fi: z(), fq: z(), si: z(), sq: z(), gi: z(), gq: z() };
                }
                mix[0].mix(x.I, x.Q, bufs.mi, bufs.mq, m, rate);
                fir[0].process(bufs.mi, bufs.mq, bufs.fi, bufs.fq, m);
                mix[1].mix(x.I, x.Q, bufs.si, bufs.sq, m, rate);
                fir[1].process(bufs.si, bufs.sq, bufs.gi, bufs.gq, m);
                const out = outs[0].re;
                const sign = p.invert ? -1 : 1;
                for (let k = 0; k < m; k++) {
                    const pm = bufs.fi[k] * bufs.fi[k] + bufs.fq[k] * bufs.fq[k];
                    const ps = bufs.gi[k] * bufs.gi[k] + bufs.gq[k] * bufs.gq[k];
                    mark += 0.01 * (pm - mark);
                    space += 0.01 * (ps - space);
                    const sum = pm + ps;
                    out[k] = sum > 1e-20 ? (sign * (pm - ps)) / sum : 0;
                }
                return m;
            },
        };
    },
};

// ── start-stop framing ──────────────────────────────────────────────────────

const STOPS = [1, 1.5, 2];

/**
 * Asynchronous serial framing — a teleprinter's: an idle line at mark, a start
 * bit of space, the data bits least significant first, and a stop bit (or one
 * and a half, or two) of mark.
 *
 * It waits for mark turning to space, takes that edge as the start of a
 * character, and judges each bit over the middle half of its time — averaging
 * the soft value there rather than taking one sample, which is worth several
 * dB on a noisy signal. A start bit that is not space after all was noise and
 * is ignored; a stop bit that is not mark is a framing error, counted and the
 * character dropped. Each good character goes out as a message:
 * `{ type: 'code', value }`.
 */
export const UartBlock = {
    type: 'uart',
    label: 'Start-stop decoder',
    category: 'Digital',
    summary: 'Teleprinter framing: start bit, data bits, stop bits — soft bits in, character codes out.',
    inputs: [{ name: 'in', kind: REAL, audio: false }],
    outputs: [{ name: 'codes', kind: MESSAGE }],
    params: {
        baud: { kind: 'number', label: 'Baud', default: 45.45, min: 1, max: 600, step: 0.01, control: false },
        dataBits: { kind: 'number', label: 'Data bits', default: 5, min: 5, max: 8, step: 1, control: false },
        stopBits: {
            kind: 'choice', label: 'Stop bits', default: 1.5,
            options: STOPS.map((v) => ({ value: v, label: String(v) })),
        },
    },
    create() {
        let rate = 12000;
        let p = {};
        let sps = 264;
        let idle = true;
        let wasMark = false;
        let t = 0;
        let sums = [];
        let counts = [];
        let chars = 0;
        let errors = 0;
        return {
            configure(params, r) { p = params; rate = r; sps = rate / p.baud; },
            reset() { idle = true; wasMark = false; t = 0; chars = 0; errors = 0; },
            read() { return { chars, errors }; },
            process(ins, outs, n) {
                const x = ins[0].re;
                const bits = Math.round(p.dataBits) + 2;
                const list = outs[0].list;
                for (let k = 0; k < n; k++) {
                    const v = x[k];
                    if (idle) {
                        if (wasMark && v < 0) {
                            idle = false;
                            t = 0;
                            sums = new Float64Array(bits);
                            counts = new Uint16Array(bits);
                        }
                        wasMark = v > 0;
                        continue;
                    }
                    t++;
                    const b = Math.floor(t / sps);
                    const within = t / sps - b;
                    if (b < bits && within >= 0.25 && within < 0.75) {
                        sums[b] += v;
                        counts[b]++;
                    }
                    // Once the stop bit's middle is past, the character is known.
                    if (t >= (bits - 1 + 0.75) * sps) {
                        idle = true;
                        wasMark = v > 0;
                        if (!(sums[0] < 0)) continue;          // not a start bit after all
                        if (!(sums[bits - 1] > 0)) {            // no stop bit: a framing error
                            errors++;
                            continue;
                        }
                        let value = 0;
                        for (let i = 1; i < bits - 1; i++) if (sums[i] > 0) value |= 1 << (i - 1);
                        chars++;
                        list.push({ type: 'code', value });
                    }
                }
                return 0;
            },
        };
    },
};

/** ITA2 codes to text, with letters and figures shift. */
export const Ita2DecoderBlock = {
    type: 'ita2-decoder',
    label: 'ITA2 (Baudot) decoder',
    category: 'Digital',
    summary: 'RTTY’s five-bit codes to text, with letters and figures shift.',
    inputs: [{ name: 'codes', kind: MESSAGE }],
    outputs: [{ name: 'text', kind: MESSAGE }],
    params: {
        unshiftOnSpace: { kind: 'bool', label: 'Unshift on space', default: true },
    },
    create() {
        const dec = new Ita2Decoder();
        return {
            configure(p) { dec.unshiftOnSpace = p.unshiftOnSpace; },
            reset() { dec.reset(); },
            process(ins, outs) {
                const input = ins[0];
                if (!input || !input.list.length) return 0;
                let text = '';
                for (const m of input.list) if (m.type === 'code') text += dec.decode(m.value);
                if (text) outs[0].list.push({ type: 'text', text });
                return 0;
            },
        };
    },
};

// ── the console ─────────────────────────────────────────────────────────────

const CONSOLE_KEEP = 20000;

/**
 * A teleprinter's paper: the text messages that arrive, run together as they
 * would print. Carriage returns are dropped and line feeds kept, which is how
 * every RTTY program shows a teleprinter's CR LF. What it prints it passes on,
 * so a console can sit in a line of text — into a Text difference, say.
 */
export const ConsoleBlock = {
    type: 'console',
    label: 'Text console',
    category: 'Viewers',
    summary: 'Prints the text a decoder puts out, as a teleprinter would, and passes it on.',
    inputs: [{ name: 'in', kind: MESSAGE }],
    outputs: [{ name: 'out', kind: MESSAGE }],
    params: {},
    create() {
        let text = '';
        let count = 0;
        return {
            configure() {},
            reset() { text = ''; count = 0; },
            command(name) { if (name === 'clear') text = ''; },
            read() { return { text: text.slice(-4000), count }; },
            process(ins, outs) {
                const input = ins[0];
                if (!input || !input.list.length) return 0;
                for (const m of input.list) {
                    if (m.type !== 'text' || !m.text) continue;
                    const printed = m.text.replace(/\r/g, '');
                    text += printed;
                    count += m.text.length;
                    if (printed && outs[0]) outs[0].list.push({ type: 'text', text: printed });
                }
                if (text.length > CONSOLE_KEEP) text = text.slice(-CONSOLE_KEEP);
                return 0;
            },
        };
    },
};

// How often a Text difference lines its two up again, in packets: a few
// times a second, and only when either has changed.
const DIFF_EVERY = 10;

/**
 * Two lines of text side by side, and where they part: what was sent against
 * what a decoder made of it (textdiff.js). The received text is shown with
 * each wrong, extra and missing character marked, and the character error
 * rate goes out as a control — to plot, or to steer by.
 *
 * Sent text the decoder has not reached yet is still to come, not missing,
 * and what a decoder prints in noise before the message starts or after it
 * ends is shown but not counted.
 */
export const TextDiffBlock = {
    type: 'text-diff',
    label: 'Text difference',
    category: 'Viewers',
    summary: 'Compares sent text with received: marks every wrong, extra and missing character, and gives the error rate.',
    inputs: [{ name: 'sent', kind: MESSAGE }, { name: 'received', kind: MESSAGE }],
    // The character error rate, 0 to 1.
    outputs: [{ name: 'cer', kind: CONTROL }],
    params: {
        ignoreSpacing: { kind: 'bool', label: 'Ignore spacing', default: true },
        ignoreCase: { kind: 'bool', label: 'Ignore capitals', default: true },
    },
    create() {
        let sent = '';
        let received = '';
        let p = {};
        let result = null;
        let dirty = false;
        let since = 0;
        const KEEP = 4 * CONSOLE_KEEP;
        const take = (input) => {
            let t = '';
            if (input) for (const m of input.list) if (m.type === 'text' && m.text) t += m.text;
            return t;
        };
        const compare = () => {
            result = alignText(normaliseText(sent, p), normaliseText(received, p), { freeSpace: p.ignoreSpacing });
            dirty = false;
            since = 0;
        };
        return {
            configure(params) {
                const changed = params.ignoreSpacing !== p.ignoreSpacing || params.ignoreCase !== p.ignoreCase;
                p = params;
                // Compared again at the next packet, which sends it too.
                if (changed && result) {
                    dirty = true;
                    since = DIFF_EVERY;
                }
            },
            reset() { sent = ''; received = ''; result = null; dirty = false; },
            command(name) {
                if (name === 'clear') { sent = ''; received = ''; result = null; dirty = false; }
            },
            // The last comparison made, which is what the `cer` output last
            // said: the two never disagree.
            read() {
                return result ? { ...result, sentChars: sent.length, receivedChars: received.length } : null;
            },
            process(ins, outs) {
                const a = take(ins[0]);
                const b = take(ins[1]);
                if (a || b) {
                    sent = (sent + a).slice(-KEEP);
                    received = (received + b).slice(-KEEP);
                    dirty = true;
                }
                if (dirty && ++since >= DIFF_EVERY) {
                    compare();
                    if (outs[0] && result.cer !== null) emitControl(outs[0], result.cer);
                }
                return 0;
            },
        };
    },
};


// ── PSK: carrier, timing, decisions ──────────────────────────────────────────

/** Second-order loop gains for a noise bandwidth `bw` (as a fraction of the update rate), damping 0.707. */
function loopGains(bw) {
    const zeta = Math.SQRT1_2;
    const theta = bw / (zeta + 1 / (4 * zeta));
    const d = 1 + 2 * zeta * theta + theta * theta;
    return { alpha: (4 * zeta * theta) / d, beta: (4 * theta * theta) / d };
}

/**
 * A Costas loop: locks an oscillator to a PSK signal's carrier, so the
 * constellation stands still. Order 2 for BPSK, 4 for QPSK, 8 for 8PSK. Its
 * error is decision-directed — the angle between each sample and the nearest
 * constellation point — and is divided by the signal's average level, so the
 * loop behaves the same on a strong signal as a weak one.
 *
 * Its pull-in is a few times its bandwidth: get the carrier within a few
 * hertz first (a counter will say where it is). The frequency it settles on
 * goes out as a control.
 */
export const CostasLoopBlock = {
    type: 'costas-loop',
    label: 'Costas loop',
    category: 'Digital',
    summary: 'Locks to a PSK carrier — BPSK, QPSK or 8PSK — so the constellation stands still.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [{ name: 'out', kind: COMPLEX }, { name: 'hz', kind: CONTROL }],
    params: {
        order: { kind: 'choice', label: 'Points', default: 2, options: [2, 4, 8].map((v) => ({ value: v, label: v === 2 ? 'BPSK' : v === 4 ? 'QPSK' : '8PSK' })) },
        bandwidthHz: { kind: 'number', label: 'Loop bandwidth', unit: 'Hz', default: 5, min: 0.1, max: 200, step: 0.1, live: true },
    },
    create() {
        let rate = 12000;
        let p = {};
        let phase = 0;
        let freq = 0;
        let level = 0;
        let g = { alpha: 0, beta: 0 };
        return {
            configure(params, r) { p = params; rate = r; g = loopGains(p.bandwidthHz / r); },
            reset() { phase = 0; freq = 0; level = 0; },
            read() { return { hz: (freq * rate) / (2 * Math.PI) }; },
            process(ins, outs, n) {
                const { re, im } = ins[0];
                const o = outs[0];
                const M = p.order;
                const step = (2 * Math.PI) / M;
                for (let k = 0; k < n; k++) {
                    const c = Math.cos(phase);
                    const s = Math.sin(phase);
                    const yr = re[k] * c + im[k] * s;
                    const yi = im[k] * c - re[k] * s;
                    o.re[k] = yr;
                    o.im[k] = yi;
                    const mag = Math.hypot(yr, yi);
                    level += 0.001 * (mag - level);
                    const a = Math.round(Math.atan2(yi, yr) / step) * step;
                    const err = level > 0 ? (yi * Math.cos(a) - yr * Math.sin(a)) / level : 0;
                    freq += g.beta * err;
                    phase += freq + g.alpha * err;
                }
                phase %= 2 * Math.PI;
                if (outs[1]) emitControl(outs[1], (freq * rate) / (2 * Math.PI));
                return n;
            },
        };
    },
};

/** Cubic (Catmull-Rom) interpolation between b and c, at fraction t, with neighbours a and d. */
const cubic = (a, b, c, d, t) => b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));

/**
 * Symbol timing: finds where each symbol's centre is and puts out one sample
 * there per symbol — the stream at the baud rate, ready to decide.
 *
 * Gardner's detector: with the centres right, the sample halfway between two
 * centres sits on the transition, and (previous − current) × halfway averages
 * to nothing; early or late, it does not, and says which. Samples between the
 * input's are interpolated, so any number of samples per symbol works. Feed it
 * a few samples per symbol or more, band-limited to about the baud rate.
 */
export const SymbolSyncBlock = {
    type: 'symbol-sync',
    label: 'Symbol sync',
    category: 'Digital',
    summary: 'Finds each symbol’s centre: one sample per symbol out, at the baud rate. Put a constellation on it.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [{ name: 'out', kind: COMPLEX }],
    params: {
        baud: { kind: 'number', label: 'Baud', default: 31.25, min: 1, max: 100000, step: 0.01, control: false },
        bandwidth: { kind: 'number', label: 'Loop bandwidth', unit: '× baud', default: 0.02, min: 0.001, max: 0.2, step: 0.001, live: true },
    },
    rate: (inRate, p) => p.baud,
    maxOut: (n, p, inRate) => Math.ceil(((n * p.baud) / Math.max(1, inRate || 1)) * 1.5) + 2,
    create() {
        let rate = 12000;
        let p = {};
        let size = 0;
        let ringI = null;
        let ringQ = null;
        let total = 0;
        let next = 0;
        let period = 1;
        let adjust = 0;
        let prevI = 0;
        let prevQ = 0;
        let have = false;
        let level = 0;
        let g = { alpha: 0, beta: 0 };
        const at = (ring, t) => {
            const i = Math.floor(t);
            const f = t - i;
            const get = (j) => ring[((j % size) + size) % size];
            return cubic(get(i - 1), get(i), get(i + 1), get(i + 2), f);
        };
        return {
            configure(params, r) {
                p = params;
                rate = r;
                const sps = r / p.baud;
                const want = 1 << Math.ceil(Math.log2(Math.ceil(sps * 3) + 16));
                if (want !== size) {
                    size = want;
                    ringI = new Float64Array(size);
                    ringQ = new Float64Array(size);
                    total = 0;
                    next = sps;
                    adjust = 0;
                    have = false;
                }
                period = sps;
                g = loopGains(p.bandwidth);
            },
            reset() { total = 0; next = period; adjust = 0; have = false; if (ringI) { ringI.fill(0); ringQ.fill(0); } },
            process(ins, outs, n) {
                const { re, im } = ins[0];
                const o = outs[0];
                let m = 0;
                for (let k = 0; k < n; k++) {
                    ringI[total % size] = re[k];
                    ringQ[total % size] = im[k];
                    total++;
                    while (next + 2 < total) {
                        const yi = at(ringI, next);
                        const yq = at(ringQ, next);
                        const hi = at(ringI, next - period / 2);
                        const hq = at(ringQ, next - period / 2);
                        let step = period;
                        if (have) {
                            // Against the power at the strobe and halfway
                            // both: started near the boundaries, where PSK31's
                            // idle passes through zero, the strobes alone have
                            // next to none, and a detector divided by that
                            // alone flails instead of pulling away.
                            level += 0.05 * ((yi * yi + yq * yq + hi * hi + hq * hq) / 2 - level);
                            const e = level > 0 ? ((prevI - yi) * hi + (prevQ - yq) * hq) / level : 0;
                            adjust += g.beta * e;
                            step = period * (1 + adjust + g.alpha * e);
                        }
                        o.re[m] = yi;
                        o.im[m] = yq;
                        m++;
                        prevI = yi;
                        prevQ = yq;
                        have = true;
                        next += Math.max(period * 0.5, Math.min(period * 1.5, step));
                    }
                }
                // Keep the counts small, so they never lose precision.
                if (total > size * 1024) {
                    const back = size * 512;
                    total -= back;
                    next -= back;
                }
                return m;
            },
        };
    },
};

const SLICER_MODES = [
    { value: 'dbpsk', label: 'Differential BPSK (PSK31)', bits: 1 },
    { value: 'bpsk', label: 'BPSK', bits: 1 },
    { value: 'qpsk', label: 'QPSK', bits: 2 },
    { value: '8psk', label: '8PSK', bits: 3 },
];
const GRAY = (k) => k ^ (k >> 1);

/**
 * Symbols to bits. Differential BPSK is PSK31's: a symbol the same as the last
 * is a 1, a reversal a 0 — which needs no carrier lock, only a carrier close
 * enough not to turn far in one symbol. The others decide each symbol by the
 * constellation point it is nearest, Gray-coded so the commonest error (a
 * neighbour) costs one bit; they want a Costas loop in front.
 */
export const PskSlicerBlock = {
    type: 'psk-slicer',
    label: 'PSK slicer',
    category: 'Digital',
    summary: 'Symbols to bits: differential BPSK (PSK31), BPSK, QPSK or 8PSK.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [{ name: 'bits', kind: BITS }],
    params: {
        mode: { kind: 'choice', label: 'Mode', default: 'dbpsk', options: SLICER_MODES.map(({ value, label }) => ({ value, label })) },
    },
    rate: (inRate, p) => inRate * (SLICER_MODES.find((m) => m.value === p.mode) || SLICER_MODES[0]).bits,
    maxOut: (n) => n * 3 + 3,
    create() {
        let p = {};
        let pr = 0;
        let pi = 0;
        return {
            configure(params) { p = params; },
            reset() { pr = 0; pi = 0; },
            process(ins, outs, n) {
                const { re, im } = ins[0];
                const out = outs[0].re;
                let m = 0;
                for (let k = 0; k < n; k++) {
                    const r = re[k];
                    const i = im[k];
                    switch (p.mode) {
                        case 'bpsk':
                            out[m++] = r > 0 ? 1 : 0;
                            break;
                        case 'qpsk':
                        case '8psk': {
                            const M = p.mode === 'qpsk' ? 4 : 8;
                            const bits = M === 4 ? 2 : 3;
                            const sector = ((Math.round((Math.atan2(i, r) * M) / (2 * Math.PI)) % M) + M) % M;
                            const g = GRAY(sector);
                            for (let b = bits - 1; b >= 0; b--) out[m++] = (g >> b) & 1;
                            break;
                        }
                        default:
                            out[m++] = r * pr + i * pi > 0 ? 1 : 0;
                    }
                    pr = r;
                    pi = i;
                }
                return m;
            },
        };
    },
};

/** PSK31's Varicode: bits to text, a character after each "00". */
export const VaricodeDecoderBlock = {
    type: 'varicode-decoder',
    label: 'Varicode decoder',
    category: 'Digital',
    summary: 'PSK31’s character code: bits to text.',
    inputs: [{ name: 'bits', kind: BITS }],
    outputs: [{ name: 'text', kind: MESSAGE }],
    params: {},
    create() {
        const dec = new VaricodeDecoder();
        return {
            configure() {},
            reset() { dec.reset(); },
            process(ins, outs, n) {
                const b = ins[0].re;
                let text = '';
                for (let k = 0; k < n; k++) text += dec.push(b[k] ? 1 : 0);
                if (text) outs[0].list.push({ type: 'text', text });
                return 0;
            },
        };
    },
};

// ── CW ──────────────────────────────────────────────────────────────────────

/**
 * On-off keying to a key level, 0 up and 1 down — CW. A narrow filter on the
 * carrier, its envelope, and two levels learned from it: the key-down level
 * and the noise. Each learns only from the samples on its own side of the
 * midpoint between them — so the noise level is the noise's average, not its
 * dips, and noise between marks reads near 0 rather than a third of the way
 * up. The key is where the envelope sits between the two, which reads the
 * same on a weak signal as a strong one and follows QSB. Too little between
 * them is no signal, and reads 0.
 */
export const OokDetectorBlock = {
    type: 'ook-detector',
    label: 'On-off detector (CW)',
    category: 'Digital',
    summary: 'A keyed carrier to a key level, 0 to 1, following fades — CW’s first stage. Centre it on zero first.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [{ name: 'key', kind: REAL, audio: false }, { name: 'snr', kind: CONTROL }],
    params: {
        bandwidthHz: { kind: 'number', label: 'Bandwidth', unit: 'Hz', default: 100, min: 10, max: 1000, step: 5, control: false },
        smoothMs: { kind: 'number', label: 'Smoothing', unit: 'ms', default: 4, min: 0, max: 50, step: 0.5, live: true },
    },
    rate: (inRate, p) => inRate / Math.max(1, Math.floor(inRate / Math.max(500, 2 * p.bandwidthHz + 200))),
    maxOut: (n) => n + 1,
    create() {
        const narrow = new Narrower();
        const fir = new ComplexFir();
        let inRate = 12000;
        let rate = 12000;
        let key = '';
        let fi = new Float64Array(0);
        let fq = new Float64Array(0);
        let peak = 0;
        let floor = 0;
        let up = 0;
        // Toward the marks' average, both ways.
        let downP = 0;
        let downF = 0;
        let upF = 0;
        let smooth = 1;
        let env = 0;
        // Whether the levels have been given a first value. Not "floor is
        // zero": a clean signal's silence has a floor of exactly zero.
        let primed = false;
        // The envelope as it was `lag` samples ago — the key is judged on
        // that, while the levels learn from now. See process.
        let lag = 0;
        let hist = new Float64Array(1);
        let hpos = 0;
        return {
            configure(p, r) {
                inRate = r;
                rate = narrow.configure(r, 500, p.bandwidthHz);
                const k = `${rate}/${p.bandwidthHz}`;
                if (k !== key) {
                    key = k;
                    fir.setTaps(designLowpass(p.bandwidthHz / 2, rate, Math.max(10, p.bandwidthHz / 2)));
                    // Judged this far behind the levels: see process.
                    lag = Math.max(0, (fir.n - 1) / 2);
                    hist = new Float64Array(lag + 1);
                    hpos = 0;
                }
                const coef = (sec) => 1 - Math.exp(-1 / (rate * sec));
                smooth = p.smoothMs > 0 ? coef(p.smoothMs / 1000) : 1;
                up = coef(0.002);
                // About the filter's own response time: long enough to average
                // the noise on a mark, short enough that the first mark of a
                // new signal has its level by the time it ends.
                downP = coef(0.01);
                downF = coef(0.15);
                upF = coef(3);
            },
            reset() { narrow.reset(); fir.reset(); peak = 0; floor = 0; env = 0; primed = false; hist.fill(0); hpos = 0; },
            latency() { return (Math.max(0, (fir.n - 1) / 2) + lag) * (inRate / rate); },
            read() { return { snrDb: peak > 0 && floor > 0 ? 20 * Math.log10(peak / floor) : null }; },
            process(ins, outs, n) {
                const x = narrow.process(ins[0].re, ins[0].im, n, inRate);
                const m = x.n;
                if (fi.length < m) { fi = new Float64Array(m); fq = new Float64Array(m); }
                fir.process(x.I, x.Q, fi, fq, m);
                const out = outs[0].re;
                for (let k = 0; k < m; k++) {
                    env += smooth * (Math.hypot(fi[k], fq[k]) - env);
                    if (!primed) { floor = env; peak = env; primed = true; }
                    const mid = (peak + floor) / 2;
                    // The key-down level is the marks' average, not their
                    // peaks — a level chasing noise peaks sits above the
                    // ordinary mark, which then reads low and breaks up. Only
                    // a much stronger signal arriving moves it at once.
                    if (env > mid) peak += (env > 1.5 * peak ? up : downP) * (env - peak);
                    else {
                        floor += downF * (env - floor);
                        // With nothing keyed for a while the key-down level
                        // sinks too, so a station that stops is no station.
                        peak += upF * (env - peak);
                    }
                    // The key is judged on the envelope from a filter's
                    // group delay ago, while the levels above learn from now.
                    // The filter is linear-phase, so it rings for that long
                    // before every mark; judged on the moment, the ringing
                    // ahead of a new signal's first mark — tiny, but far
                    // above a quiet band's floor — would start the mark early.
                    // Judged this far back, the level already knows how
                    // strong the mark is, and the ringing reads as nothing.
                    hist[hpos] = env;
                    hpos = hpos + 1 === hist.length ? 0 : hpos + 1;
                    const was = hist[hpos];
                    const span = peak - floor;
                    // Under 6 dB between peak and floor is no signal at all.
                    out[k] = peak > floor * 2 && span > 0 ? Math.max(0, Math.min(1, (was - floor) / span)) : 0;
                }
                if (outs[1] && floor > 0) emitControl(outs[1], 20 * Math.log10(Math.max(peak, 1e-12) / floor));
                return m;
            },
        };
    },
};

// How many recent marks and gaps the speed is learned from: enough to see
// both dots and dashes, few enough to follow a sender who speeds up.
const MORSE_RECENT = 16;
// A change of key must last this long to count — noise flickering across the
// threshold is not keying.
const MORSE_DEBOUNCE_SEC = 0.008;

/** Two clusters of positive numbers, by their logarithms: [short, long] means, or null. */
function twoClusters(xs) {
    if (xs.length < 2) return null;
    let lo = Math.min(...xs);
    let hi = Math.max(...xs);
    if (hi / lo < 1.8) return null;
    for (let it = 0; it < 6; it++) {
        const split = Math.sqrt(lo * hi);
        const a = xs.filter((x) => x < split);
        const b = xs.filter((x) => x >= split);
        if (!a.length || !b.length) return null;
        lo = a.reduce((s, x) => s + x, 0) / a.length;
        hi = b.reduce((s, x) => s + x, 0) / b.length;
    }
    return hi / lo >= 1.8 ? [lo, hi] : null;
}

/**
 * Text to Morse: a keyed tone, as the text arrives (playground/keyer.js). The
 * speed is the setting, or — with the `wpm` input wired, from a slider or a
 * Morse decoder's own estimate — whatever arrives there. `key` is the key's
 * level, 0 to 1, for a scope or a decoder; `sent` the text, a character at a
 * time as each goes out, for a text diff against what was copied.
 */
export const MorseEncoderBlock = {
    type: 'morse-encoder',
    label: 'Morse encoder',
    category: 'Digital',
    summary: 'Text to a CW tone, sent as it arrives: from a console, a decoder, anything with text. Wire a slider or a Morse decoder’s wpm into “wpm” to set the speed from there.',
    inputs: [{ name: 'text', kind: MESSAGE }, { name: 'wpm', kind: CONTROL, optional: true }],
    outputs: [{ name: 'audio', kind: REAL }, { name: 'key', kind: REAL, audio: false }, { name: 'sent', kind: MESSAGE }],
    params: {
        wpm: { kind: 'number', label: 'Speed', unit: 'wpm', default: KD.wpm, min: WPM_MIN, max: WPM_MAX, step: 1, live: true },
        farnsworthWpm: { kind: 'number', label: 'Farnsworth (0 = off)', unit: 'wpm', default: KD.farnsworthWpm, min: 0, max: WPM_MAX, step: 1, live: true },
        pitchHz: { kind: 'number', label: 'Pitch', unit: 'Hz', default: KD.pitchHz, min: 200, max: 2000, step: 10, live: true },
        levelDb: { kind: 'number', label: 'Level', unit: 'dBFS', default: KD.levelDb, min: -40, max: 0, step: 1, live: true },
        riseMs: { kind: 'number', label: 'Rise time', unit: 'ms', default: KD.riseMs, min: 1, max: 20, step: 0.5, live: true },
    },
    create() {
        const keyer = new Keyer();
        let wpmIn = null;
        return {
            configure(p, r) { keyer.configure(p, r); },
            reset() { keyer.reset(); },
            command(name) { if (name === 'clear') keyer.reset(); },
            read() { return { ...keyer.state(wpmIn), fromInput: wpmIn != null }; },
            // A source of samples: as many as the stream brings, sent or silent.
            process(ins, outs, n) {
                const text = ins[0];
                if (text && text.list) for (const m of text.list) if (m && m.type === 'text' && m.text) keyer.queue(m.text);
                const w = ins[1];
                wpmIn = w && w.value != null && Number(w.value) > 0 ? Number(w.value) : null;
                keyer.process(outs[0].re, n, wpmIn, outs[1] ? outs[1].re : null);
                const sent = keyer.takeSent();
                if (sent && outs[2]) outs[2].list.push({ type: 'text', text: sent });
                return n;
            },
        };
    },
};

/**
 * Morse from a key level.
 *
 * Dots from dashes by where the recent marks split into two groups — not by a
 * fixed ratio to a guessed speed, so a mark the detector shortens or lengthens
 * a little is still on the right side, and any speed from slow to fast is
 * found from the first few letters. The dit itself is the average of the short
 * marks and the gaps inside letters: whatever the thresholds take off a mark
 * they add to its gap, so the average is right when neither is. Gaps of two
 * dits end a letter, five a word. A key change must last a few milliseconds to
 * count, which keeps noise flicker out. Set a speed to fix it instead. The
 * speed it reads goes out as a control.
 */
export const MorseDecoderBlock = {
    type: 'morse-decoder',
    label: 'Morse decoder',
    category: 'Digital',
    summary: 'A key level to text, following the sender’s speed.',
    inputs: [{ name: 'key', kind: REAL, audio: false }],
    // What its card's activity dot means: see activity() below.
    activity: 'The key is down',
    outputs: [{ name: 'text', kind: MESSAGE }, { name: 'wpm', kind: CONTROL }],
    params: {
        wpm: { kind: 'number', label: 'Speed (0 = follow)', unit: 'wpm', default: 0, min: 0, max: 60, step: 1 },
    },
    create() {
        let rate = 12000;
        let p = {};
        let dit = 0;
        let split = 0;
        let deb = 96;
        let baseDeb = 96;
        let down = false;
        // Whether the key went down since activity() last asked.
        let keyed = false;
        let run = 0;
        let cand = 0;
        let pattern = '';
        let wordPending = false;
        let marks = [];
        let gaps = [];
        let lastMark = 0;
        // This letter's marks, decided when it ends. A letter with both dots
        // and dashes in it splits them itself — they are two clear groups,
        // whatever the speed, so even the first letter is right before
        // anything has been learned. One of all dots or all dashes has no
        // second group to compare with, and takes the learned split.
        let letter = [];

        const fixed = () => p.wpm > 0;
        const finish = () => {
            const c = !fixed() ? twoClusters(letter) : null;
            const at = c ? Math.sqrt(c[0] * c[1]) : split;
            const out = morseChar(letter.map((d) => (d > at ? '-' : '.')).join(''));
            letter = [];
            pattern = '';
            return out;
        };
        const start = () => {
            dit = (1.2 / (fixed() ? p.wpm : 20)) * rate;
            deb = Math.max(baseDeb, Math.round(0.3 * dit));
            split = 2 * dit;
            marks = [];
            gaps = [];
            lastMark = 0;
        };
        const relearn = () => {
            if (fixed()) return;
            const c = twoClusters(marks);
            let short;
            if (c) {
                short = c[0];
                split = Math.sqrt(c[0] * c[1]);
            } else if (marks.length >= 3 && gaps.length >= 2) {
                // All one kind of mark so far: the gaps say which.
                const m = marks.reduce((s, x) => s + x, 0) / marks.length;
                const g = gaps.reduce((s, x) => s + x, 0) / gaps.length;
                short = m < 2 * g ? m : m / 3;
                split = Math.sqrt(3) * short;
            } else return;
            const g = gaps.length >= 2 ? gaps.reduce((s, x) => s + x, 0) / gaps.length : short;
            // At most 15% a step: a sender changes speed over letters, and a
            // burst of noise should not fling the estimate anywhere at once.
            dit = Math.max(dit * 0.85, Math.min(dit * 1.15, (short + g) / 2));
            deb = Math.max(baseDeb, Math.round(0.3 * dit));
        };
        const ended = (wasDown, dur) => {
            if (wasDown) {
                letter.push(dur);
                pattern += dur > split ? '-' : '.';
                marks.push(dur);
                if (marks.length > MORSE_RECENT) marks.shift();
                lastMark = dur;
                relearn();
            } else if (lastMark && dur < 2 * dit) {
                gaps.push(dur);
                if (gaps.length > MORSE_RECENT) gaps.shift();
                relearn();
            }
        };
        return {
            configure(params, r) {
                const was = p.wpm;
                p = params;
                if (r !== rate || !dit || was !== p.wpm) {
                    rate = r;
                    start();
                }
                // A change must last a few milliseconds, and three tenths of
                // a dit once the speed is known — a glitch is never a mark.
                baseDeb = Math.max(1, Math.round(MORSE_DEBOUNCE_SEC * rate));
                deb = Math.max(baseDeb, Math.round(0.3 * dit));
            },
            reset() { down = false; run = 0; cand = 0; pattern = ''; letter = []; wordPending = false; start(); },
            read() { return { wpm: (1.2 * rate) / dit, pattern }; },
            // The card's activity dot: lit while the key is down, so it
            // flashes in time with the Morse.
            activity() {
                const was = keyed || down;
                keyed = false;
                return was ? 1 : 0;
            },
            process(ins, outs, n) {
                const x = ins[0].re;
                let text = '';
                for (let k = 0; k < n; k++) {
                    const v = x[k];
                    const want = down ? v > 0.4 : v > 0.6;
                    run++;
                    if (want !== down) {
                        if (++cand >= deb) {
                            ended(down, run - cand);
                            down = want;
                            run = cand;
                            cand = 0;
                        }
                    } else cand = 0;
                    if (down) keyed = true;
                    if (!down) {
                        if (letter.length && run > 2 * dit) {
                            text += finish();
                            wordPending = true;
                            lastMark = 0;
                        } else if (wordPending && run > 5 * dit) {
                            text += ' ';
                            wordPending = false;
                        }
                    }
                }
                if (text) outs[0].list.push({ type: 'text', text });
                if (outs[1]) emitControl(outs[1], (1.2 * rate) / dit);
                return 0;
            },
        };
    },
};

// ── synchronous FSK: NAVTEX ─────────────────────────────────────────────────

/**
 * Bit timing for a synchronous signal — one with no start and stop bits, like
 * SITOR-B — from soft bits: a clock running at the baud rate, pulled toward
 * the transitions it sees, and each bit decided over its whole length.
 */
export const BitSyncBlock = {
    type: 'bit-sync',
    label: 'Bit sync',
    category: 'Digital',
    summary: 'Clock recovery for synchronous FSK: soft bits in, one decided bit per bit time out.',
    inputs: [{ name: 'in', kind: REAL, audio: false }],
    outputs: [{ name: 'bits', kind: BITS }],
    params: {
        baud: { kind: 'number', label: 'Baud', default: 100, min: 1, max: 10000, step: 0.01, control: false },
        gain: { kind: 'number', label: 'Tracking', default: 0.05, min: 0.001, max: 0.5, step: 0.001, live: true },
    },
    rate: (inRate, p) => p.baud,
    maxOut: (n, p, inRate) => Math.ceil((n * p.baud) / Math.max(1, inRate || 1)) + 2,
    create() {
        let rate = 12000;
        let p = {};
        let phase = 0;
        let sum = 0;
        let last = 0;
        return {
            configure(params, r) { p = params; rate = r; },
            reset() { phase = 0; sum = 0; last = 0; },
            process(ins, outs, n) {
                const x = ins[0].re;
                const out = outs[0].re;
                const step = p.baud / rate;
                let m = 0;
                for (let k = 0; k < n; k++) {
                    const v = x[k];
                    // A transition should fall on a bit boundary — phase 0.
                    if ((v > 0) !== (last > 0)) {
                        const err = phase < 0.5 ? phase : phase - 1;
                        phase -= p.gain * err;
                    }
                    last = v;
                    sum += v;
                    phase += step;
                    if (phase >= 1) {
                        phase -= 1;
                        out[m++] = sum > 0 ? 1 : 0;
                        sum = 0;
                    }
                }
                return m;
            },
        };
    },
};

/**
 * SITOR-B — NAVTEX's code — from bits to text. Finds the character boundaries
 * itself, by watching which of the seven ways of grouping the bits keeps
 * giving valid four-mark codes, then decodes with CCIR 476's repetition: each
 * character arrives twice, and either good copy will do. Too many bad
 * characters in a row and it goes back to looking.
 */
export const SitorDecoderBlock = {
    type: 'sitor-decoder',
    label: 'SITOR-B decoder',
    category: 'Digital',
    summary: 'NAVTEX’s code: synchronous bits to text, with its error correction.',
    inputs: [{ name: 'bits', kind: BITS }],
    outputs: [{ name: 'text', kind: MESSAGE }],
    params: {},
    create() {
        const dec = new SitorDecoder();
        let reg = 0;
        let count = 0;
        const score = new Float64Array(7);
        let locked = -1;
        let bad = 0;
        let chars = 0;
        return {
            configure() {},
            reset() { dec.reset(); reg = 0; count = 0; score.fill(0); locked = -1; bad = 0; },
            read() { return { locked: locked >= 0, chars }; },
            process(ins, outs, n) {
                const b = ins[0].re;
                let text = '';
                for (let k = 0; k < n; k++) {
                    reg = (reg >> 1) | ((b[k] ? 1 : 0) << 6);
                    count++;
                    const slot = count % 7;
                    if (locked < 0) {
                        score[slot] += 0.25 * ((ccirValid(reg) ? 1 : 0) - score[slot]);
                        // Fourteen-odd good codes running at one alignment, and
                        // the others far behind: that is where characters are.
                        if (count > 70 && score[slot] > 0.9) {
                            locked = slot;
                            bad = 0;
                            dec.reset();
                        }
                        continue;
                    }
                    if (slot !== locked) continue;
                    const r = dec.push(reg);
                    if (r.ok) {
                        if (bad > 0) bad--;
                        text += r.text;
                        if (r.text) chars++;
                    } else if (++bad > 4) {
                        locked = -1;
                        score.fill(0);
                    }
                }
                if (text) outs[0].list.push({ type: 'text', text: text.replace(/\r/g, '') });
                return 0;
            },
        };
    },
};

// How many of the newest bits a bit viewer shows.
const BITS_SHOWN = 128;

/** The newest bits on a wire, and how many have gone by. */
export const BitViewBlock = {
    type: 'bit-view',
    label: 'Bit viewer',
    category: 'Viewers',
    summary: 'The newest bits on a wire — watch a slicer decide, or idle turn into data.',
    inputs: [{ name: 'in', kind: BITS }],
    outputs: [],
    params: {},
    create() {
        const ring = new Uint8Array(BITS_SHOWN);
        let pos = 0;
        let count = 0;
        let ones = 0;
        return {
            configure() {},
            reset() { pos = 0; count = 0; ones = 0; ring.fill(0); },
            read() {
                const n = Math.min(count, BITS_SHOWN);
                const bits = new Uint8Array(n);
                for (let k = 0; k < n; k++) bits[k] = ring[(pos - n + k + BITS_SHOWN) % BITS_SHOWN];
                return { bits, count, ones };
            },
            process(ins, outs, n) {
                const x = ins[0].re;
                for (let k = 0; k < n; k++) {
                    const b = x[k] ? 1 : 0;
                    ring[pos] = b;
                    pos = (pos + 1) % BITS_SHOWN;
                    count++;
                    ones += b;
                }
                return 0;
            },
        };
    },
};
