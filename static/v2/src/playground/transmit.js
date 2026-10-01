// Test signals for the decoders: CW, RTTY, PSK31 (and 63, 125) and NAVTEX, as
// a transmitter would send them, sample by sample.
//
// The playground's decoders need something to decode, and the band does not
// always oblige. These are built with the same encoders (codes.js) the
// decoders' own tests use, so a transmitter and a decoder cannot disagree
// about a code — only about the things on the air that a decoder is there to
// cope with: speed, shift, level and noise.
//
// Every mode reduces to one thing: at time t into the message, how far from
// the carrier the signal is and how strong. FSK moves the frequency (with
// continuous phase, as a real modulator's does); CW and PSK move the amplitude
// — PSK's through zero, which is its phase reversal.

import {
    Ita2Decoder, SitorDecoder, VaricodeDecoder, encodeIta2, encodeMorse, encodeSitorB, encodeVaricode, morseChar,
} from './codes.js';

export const TX_MODES = [
    { value: 'cw', label: 'CW' },
    { value: 'rtty', label: 'RTTY' },
    { value: 'psk', label: 'PSK' },
    { value: 'navtex', label: 'NAVTEX' },
];

/** What each mode sends when no message is given. */
export const TEST_MESSAGES = {
    cw: 'VVV CQ CQ DE TEST TEST K 599 TU 73',
    rtty: 'RYRYRY CQ CQ DE TEST TEST K\nTHE QUICK BROWN FOX JUMPS OVER THE LAZY DOG 1234567890',
    psk: 'CQ CQ de TEST TEST pse k\nThe quick brown fox jumps over the lazy dog 0123456789.',
    navtex: 'ZCZC GA01\nSECURITE\nGALE WARNING 042 SW 8 IN DOVER.\nNNNN',
};

// SNR is quoted in this bandwidth, as digital modes' usually is, so that a
// figure means the same on any stream: noise is spread across the whole of it.
export const SNR_BANDWIDTH_HZ = 2500;

// Long enough for a decoder to find the signal and settle before the text.
const LEAD_SEC = 1.5;
const NAVTEX_BAUD = 100;
const NAVTEX_SHIFT_HZ = 170;

/** The text a transmitter's settings send. */
export const messageOf = (p) => (p.text && p.text.trim() ? p.text : TEST_MESSAGES[p.mode] || '');

/**
 * Times at which a held value changes: `[[t, value], …]` from a list of
 * `[value, seconds]`. Returns the edges and the total length.
 */
function edgesOf(steps) {
    const edges = [];
    let t = 0;
    for (const [v, sec] of steps) {
        edges.push([t, v]);
        t += sec;
    }
    return { edges, seconds: t };
}

/**
 * A message as a function of time: `at(t)` gives `{ hz, amp }`, the offset
 * from the carrier and the amplitude (negative for PSK's reversed phase), and
 * `seconds` how long it lasts. `idle` is what it sends between repeats.
 *
 * `sent` is the text as it goes out, `[[t, text], …]`: each character at the
 * moment its last symbol ends, which is when a perfect receiver could print
 * it. It comes from the codes actually sent, read back with the decoders' own
 * tables (codes.js), so it shows what the mode can carry — CW and RTTY in
 * capitals, with what they cannot send left out — and NAVTEX's text when its
 * repeat arrives, as a receiver prints it.
 */
export function messageSignal(p) {
    const text = messageOf(p);
    switch (p.mode) {
        case 'cw': {
            const dit = 1.2 / p.wpm;
            const elements = encodeMorse(text);
            const { edges, seconds } = edgesOf([[false, LEAD_SEC], ...elements.map(([on, u]) => [on, u * dit]), [false, 7 * dit]]);
            // A character ends at a gap of three units, a word at seven.
            const sent = [];
            let pattern = '';
            let t = LEAD_SEC;
            elements.forEach(([on, units], i) => {
                if (on) pattern += units === 1 ? '.' : '-';
                t += units * dit;
                const last = i === elements.length - 1;
                // A word of nothing CW can send leaves a longer gap, not a
                // second space.
                if (((!on && units >= 3) || last) && pattern) {
                    sent.push([on ? t : t - units * dit, morseChar(pattern) + (!on && units >= 7 ? ' ' : '')]);
                    pattern = '';
                }
            });
            const rise = Math.max(0.0005, p.riseMs / 1000);
            let i = 0;
            return {
                seconds,
                sent,
                idle: { hz: 0, amp: 0 },
                start() { i = 0; },
                at(t) {
                    while (i + 1 < edges.length && edges[i + 1][0] <= t) i++;
                    if (!edges[i][1]) return { hz: 0, amp: 0 };
                    const end = i + 1 < edges.length ? edges[i + 1][0] : seconds;
                    // A raised-cosine edge either end: the key clicks no wider
                    // than the rise time says.
                    const r = Math.min(1, (t - edges[i][0]) / rise, (end - t) / rise);
                    return { hz: 0, amp: Math.sin((Math.PI / 2) * Math.max(0, r)) ** 2 };
                },
            };
        }
        case 'rtty': {
            // Idle on mark; each code a start bit, five data bits least
            // significant first, and the stop bits — all at the baud rate.
            const T = 1 / p.baud;
            const steps = [[1, LEAD_SEC]];
            const sent = [];
            const ita2 = new Ita2Decoder();
            let t = LEAD_SEC;
            for (const c of encodeIta2(text)) {
                steps.push([0, T]);
                for (let b = 0; b < 5; b++) steps.push([(c >> b) & 1, T]);
                steps.push([1, p.stopBits * T]);
                t += (6 + p.stopBits) * T;
                const ch = ita2.decode(c);
                if (ch) sent.push([t, ch]);
            }
            steps.push([1, 10 * T]);
            return fsk(steps, p.shiftHz, p.invert, { hz: (p.invert ? -1 : 1) * (p.shiftHz / 2), amp: 1 }, sent);
        }
        case 'navtex': {
            // SITOR-B: the codes as they come, seven bits each, least
            // significant first — phasing first, from the encoder.
            const T = 1 / NAVTEX_BAUD;
            const steps = [];
            for (let k = 0; k < LEAD_SEC * NAVTEX_BAUD; k++) steps.push([k % 2, T]);
            const sent = [];
            const sitor = new SitorDecoder();
            let t = steps.length * T;
            for (const c of encodeSitorB(text)) {
                for (let b = 0; b < 7; b++) steps.push([(c >> b) & 1, T]);
                t += 7 * T;
                const ch = sitor.push(c).text.replace(/\r/g, '');
                if (ch) sent.push([t, ch]);
            }
            return fsk(steps, NAVTEX_SHIFT_HZ, p.invert, { hz: 0, amp: 0 }, sent);
        }
        case 'psk': {
            // Differential BPSK: a 0 a reversal, a 1 none. Idle is reversals,
            // which is what lets a receiver find the timing; the end is a run
            // of them and then the carrier, as a transmitter signs off.
            const lead = Math.max(40, Math.round(LEAD_SEC * p.pskBaud));
            const bits = [...new Array(lead).fill(0), ...encodeVaricode(text), ...new Array(20).fill(0), ...new Array(10).fill(1)];
            const amps = [];
            let a = 1;
            for (const b of bits) {
                if (!b) a = -a;
                amps.push(a);
            }
            const T = 1 / p.pskBaud;
            // Symbol j's pulse peaks at (j + 1)T: a character is complete with
            // the second zero after it.
            const sent = [];
            const varicode = new VaricodeDecoder();
            bits.forEach((b, j) => {
                const ch = varicode.push(b);
                if (ch) sent.push([(j + 1) * T, ch]);
            });
            return {
                seconds: (amps.length + 1) * T,
                sent,
                idle: { hz: 0, amp: 0 },
                start() {},
                at(t) {
                    // Each symbol a raised-cosine pulse two symbols long, so a
                    // reversal passes smoothly through zero.
                    const s0 = Math.floor(t / T);
                    let v = 0;
                    for (let j = s0 - 1; j <= s0 + 1; j++) {
                        if (j < 0 || j >= amps.length) continue;
                        const d = t - (j + 1) * T;
                        if (Math.abs(d) < T) v += amps[j] * 0.5 * (1 + Math.cos((Math.PI * d) / T));
                    }
                    return { hz: 0, amp: v };
                },
            };
        }
        default:
            return { seconds: 0, sent: [], idle: { hz: 0, amp: 0 }, start() {}, at: () => ({ hz: 0, amp: 0 }) };
    }
}

/** Continuous-phase FSK of `[bit, seconds]` steps: mark (1) the higher tone, unless inverted. */
function fsk(steps, shiftHz, invert, idle, sent) {
    const { edges, seconds } = edgesOf(steps);
    const half = (invert ? -1 : 1) * (shiftHz / 2);
    let i = 0;
    return {
        seconds,
        sent,
        idle,
        start() { i = 0; },
        at(t) {
            while (i + 1 < edges.length && edges[i + 1][0] <= t) i++;
            return { hz: edges[i][1] ? half : -half, amp: 1 };
        },
    };
}

const SILENT = { hz: 0, amp: 0 };

/**
 * A transmitter: the message over and over (or once), at an offset, a level
 * and a signal-to-noise ratio. Its phase runs on across repeats and setting
 * changes, so nothing it does clicks that a real one would not.
 */
export class Transmitter {
    constructor() {
        this.phase = 0;
        this.k = 0;
        this.loops = 0;
        this.sig = null;
        this.key = '';
        this.seed = 1;
        this.spare = null;
    }

    configure(p, rate) {
        this.p = p;
        this.rate = rate;
        // A new message, or one timed differently, starts from its beginning.
        const key = JSON.stringify([p.mode, messageOf(p), p.wpm, p.riseMs, p.baud, p.shiftHz, p.stopBits, p.invert, p.pskBaud]);
        if (key !== this.key) {
            this.key = key;
            this.sig = messageSignal(p);
            this.restart();
        }
    }

    restart() {
        this.k = 0;
        this.ev = 0;
        this.loops = 0;
        this.done = false;
        if (this.sig) this.sig.start();
    }

    reset() {
        this.phase = 0;
        this.seed = 1;
        this.spare = null;
        this.restart();
    }

    /** Where it is: sending, and how far through. */
    status() {
        const t = this.k / this.rate;
        const len = this.sig ? this.sig.seconds : 0;
        return { sending: !this.done && t < len, progress: len ? Math.min(1, t / len) : 0, loops: this.loops, seconds: len };
    }

    // Gaussian, from a small fixed-seed generator: a graph run twice runs the same.
    _gauss() {
        if (this.spare !== null) {
            const s = this.spare;
            this.spare = null;
            return s;
        }
        const u = this._uniform() || 1e-12;
        const v = this._uniform();
        const r = Math.sqrt(-2 * Math.log(u));
        this.spare = r * Math.sin(2 * Math.PI * v);
        return r * Math.cos(2 * Math.PI * v);
    }

    _uniform() {
        this.seed = (this.seed + 0x6d2b79f5) >>> 0;
        let x = this.seed;
        x = Math.imul(x ^ (x >>> 15), x | 1);
        x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    }

    /** `n` samples into `re`/`im`; returns the text that went out in them. */
    process(re, im, n) {
        const p = this.p;
        const rate = this.rate;
        const sig = this.sig;
        const level = 10 ** (p.levelDb / 20);
        // Noise across the whole stream, at the density that puts the SNR
        // asked for into SNR_BANDWIDTH_HZ of it.
        const sigma = p.noise ? level * Math.sqrt((10 ** (-p.snrDb / 10)) * (rate / SNR_BANDWIDTH_HZ) / 2) : 0;
        const len = Math.round(sig.seconds * rate);
        const gap = Math.round(Math.max(0, p.gapSec) * rate);
        const sent = sig.sent;
        let text = '';
        for (let j = 0; j < n; j++) {
            let s;
            if (this.done) s = SILENT;
            else if (this.k < len) s = sig.at(this.k / rate);
            else s = sig.idle;
            this.phase += (2 * Math.PI * (p.offsetHz + s.hz)) / rate;
            re[j] = level * s.amp * Math.cos(this.phase) + (sigma ? sigma * this._gauss() : 0);
            im[j] = level * s.amp * Math.sin(this.phase) + (sigma ? sigma * this._gauss() : 0);
            if (this.done) continue;
            this.k++;
            while (this.ev < sent.length && sent[this.ev][0] * rate <= this.k) text += sent[this.ev++][1];
            if (this.k >= len + gap) {
                if (p.repeat) {
                    // Each copy on a line of its own: a decoder cannot know
                    // where one ends, but the transmitter does.
                    text += '\n';
                    this.k = 0;
                    this.ev = 0;
                    this.loops++;
                    sig.start();
                } else {
                    this.done = true;
                    this.loops++;
                }
            }
        }
        this.phase %= 2 * Math.PI;
        return text;
    }
}
