// Convolutional codes: a rate-½ encoder and its Viterbi decoder.
//
// The code is fldigi's (src/psk/viterbi.cxx) to the bit, so what is decoded
// here is what fldigi sends: a shift register of K bits, the newest in the
// lowest bit; each input bit sends two, the parities of the register under
// each polynomial, the first in the low bit of the pair. QPSK31 is K = 5 with
// 0x17 and 0x19; the "NASA" K = 7 code is 0x6d and 0x4f (171/133 octal, bit
// reversed), which PSK-R and many others use.
//
// The decoder takes, for each pair, a score for each of the four pairs that
// could have been sent — higher is likelier — so a demodulator can hand it
// soft decisions (QPSK31's slicer scores the four phases). Hard bits score 1
// per matching bit. It decides a bit `depth` pairs late, which is how far back
// the survivors have long since merged.

import { BITS, REAL } from '../block.js';

const parity = (x) => { let p = 0; while (x) { p ^= x & 1; x >>>= 1; } return p; };

export const CODES = {
    qpsk31: { label: 'K=5 (QPSK31)', k: 5, poly1: 0x17, poly2: 0x19 },
    nasa: { label: 'K=7 (NASA, PSK-R)', k: 7, poly1: 0x6d, poly2: 0x4f },
};

/** The pair (0–3) sent for each value of the K-bit register. */
function outputTable(k, poly1, poly2) {
    const t = new Uint8Array(1 << k);
    for (let i = 0; i < t.length; i++) t[i] = parity(poly1 & i) | (parity(poly2 & i) << 1);
    return t;
}

export class ConvEncoder {
    constructor({ k, poly1, poly2 }) {
        this.table = outputTable(k, poly1, poly2);
        this.mask = (1 << k) - 1;
        this.reg = 0;
    }

    reset() { this.reg = 0; }

    /** One bit in, its pair (0–3) out. */
    encode(bit) {
        this.reg = ((this.reg << 1) | (bit ? 1 : 0)) & this.mask;
        return this.table[this.reg];
    }
}

export class Viterbi {
    constructor({ k, poly1, poly2 }, depth = k * 12) {
        this.k = k;
        this.table = outputTable(k, poly1, poly2);
        this.states = 1 << (k - 1);
        this.depth = depth;
        this.len = depth + 1;
        this.reset();
    }

    reset() {
        const { states, len } = this;
        this.metric = new Float64Array(states);
        this.next = new Float64Array(states);
        this.history = Array.from({ length: len }, () => new Uint16Array(states));
        this.ptr = 0;
        this.seen = 0;
    }

    /**
     * One pair's scores, `met[pair]`. Returns the bit decided `depth` pairs
     * ago, or -1 until that many have been seen.
     */
    step(met) {
        const { states, table, metric, next } = this;
        const hist = this.history[this.ptr];
        for (let n = 0; n < states; n++) {
            // The two registers that end in state n: n with a 0 or a 1 above it.
            const s0 = n;
            const s1 = n + states;
            const m0 = metric[s0 >> 1] + met[table[s0]];
            const m1 = metric[s1 >> 1] + met[table[s1]];
            if (m0 >= m1) { next[n] = m0; hist[n] = s0 >> 1; } else { next[n] = m1; hist[n] = s1 >> 1; }
        }
        // Kept small: only the differences between them matter.
        let best = 0;
        for (let n = 1; n < states; n++) if (next[n] > next[best]) best = n;
        const top = next[best];
        for (let n = 0; n < states; n++) metric[n] = next[n] - top;
        const at = this.ptr;
        this.ptr = (this.ptr + 1) % this.len;
        if (++this.seen <= this.depth) return -1;
        // Back from the best state to `depth` pairs ago; that state's lowest
        // bit is the bit that went in then.
        let s = best;
        let p = at;
        for (let i = 0; i < this.depth; i++) {
            s = this.history[p][s];
            p = (p - 1 + this.len) % this.len;
        }
        return s & 1;
    }
}

/** Scores for a hard pair: one for each bit that matches. */
export function hardScores(b0, b1, out = new Float64Array(4)) {
    for (let o = 0; o < 4; o++) out[o] = ((o & 1) === b0 ? 1 : 0) + (((o >> 1) & 1) === b1 ? 1 : 0);
    return out;
}

const CODE_PARAMS = {
    code: {
        kind: 'choice', label: 'Code', default: 'qpsk31',
        options: [...Object.entries(CODES).map(([value, c]) => ({ value, label: c.label })), { value: 'custom', label: 'Your own' }],
    },
    k: { kind: 'number', label: 'Constraint length', default: 7, min: 3, max: 12, step: 1, control: false, showIf: (p) => p.code === 'custom' },
    poly1: { kind: 'number', label: 'Polynomial 1', default: 0x6d, min: 1, max: 4095, step: 1, control: false, showIf: (p) => p.code === 'custom' },
    poly2: { kind: 'number', label: 'Polynomial 2', default: 0x4f, min: 1, max: 4095, step: 1, control: false, showIf: (p) => p.code === 'custom' },
};

export const codeOf = (p) => CODES[p.code] || { k: p.k | 0, poly1: p.poly1 | 0, poly2: p.poly2 | 0 };

export const ConvEncoderBlock = {
    type: 'conv-encoder',
    label: 'Convolutional encoder',
    category: 'Digital',
    summary: 'Rate ½: each bit in sends two out, the parities of the last K bits — fldigi’s codes, QPSK31’s among them.',
    inputs: [{ name: 'bits', kind: BITS }],
    outputs: [{ name: 'bits', kind: BITS }],
    params: CODE_PARAMS,
    rate: (inRate) => inRate * 2,
    maxOut: (n) => n * 2,
    create() {
        let enc = null;
        let key = '';
        return {
            configure(p) {
                const c = codeOf(p);
                const k2 = `${c.k}/${c.poly1}/${c.poly2}`;
                if (k2 !== key) { key = k2; enc = new ConvEncoder(c); }
            },
            reset() { if (enc) enc.reset(); },
            process(ins, outs, n) {
                const b = ins[0].re;
                const out = outs[0].re;
                let m = 0;
                for (let i = 0; i < n; i++) {
                    const pair = enc.encode(b[i]);
                    out[m++] = pair & 1;
                    out[m++] = (pair >> 1) & 1;
                }
                return m;
            },
        };
    },
};

export const ViterbiBlock = {
    type: 'viterbi',
    label: 'Viterbi decoder',
    category: 'Digital',
    summary: 'Undoes a rate-½ convolutional code, mending the bits the channel got wrong. Bits arrive in pairs; if it reads nonsense, try the other pairing.',
    inputs: [{ name: 'bits', kind: BITS }],
    outputs: [{ name: 'bits', kind: BITS }],
    params: {
        ...CODE_PARAMS,
        pairing: { kind: 'choice', label: 'Pairing', default: 0, options: [{ value: 0, label: 'From the first bit' }, { value: 1, label: 'From the second bit' }] },
    },
    rate: (inRate) => inRate / 2,
    maxOut: (n) => Math.ceil(n / 2) + 1,
    create() {
        let dec = null;
        let key = '';
        let skip = 0;
        let held = -1;
        const met = new Float64Array(4);
        return {
            configure(p) {
                const c = codeOf(p);
                const k2 = `${c.k}/${c.poly1}/${c.poly2}/${p.pairing}`;
                if (k2 !== key) { key = k2; dec = new Viterbi(c); skip = p.pairing ? 1 : 0; held = -1; }
            },
            reset() { key = ''; },
            latency() { return dec ? dec.depth * 2 : 0; },
            process(ins, outs, n) {
                const b = ins[0].re;
                const out = outs[0].re;
                let m = 0;
                for (let i = 0; i < n; i++) {
                    if (skip) { skip--; continue; }
                    const bit = b[i] ? 1 : 0;
                    if (held < 0) { held = bit; continue; }
                    const d = dec.step(hardScores(held, bit, met));
                    held = -1;
                    if (d >= 0) out[m++] = d;
                }
                return m;
            },
        };
    },
};

/**
 * Scores for a soft pair: each element a confidence, +1 a sure 1, −1 a sure
 * 0, 0 no idea. fldigi's viterbi::decode scores its 0–255 soft symbols the
 * same way, linearly (mettab: i − 128 for a 1, 128 − i for a 0), so a soft
 * value v here is fldigi's 128 + 127.5 v.
 */
export function softScores(v0, v1, out = new Float64Array(4)) {
    for (let o = 0; o < 4; o++) out[o] = (o & 1 ? v0 : -v0) + (o & 2 ? v1 : -v1);
    return out;
}

/**
 * The Viterbi decoder for soft bits: the same decoder, given how sure each
 * bit is rather than only which way it went — worth about 2 dB. What the MFSK
 * family's demodulators put out (see blocks/mfsk.js), and what fldigi feeds
 * its own decoder in MFSK16 and THOR.
 */
export const SoftViterbiBlock = {
    type: 'soft-viterbi',
    label: 'Viterbi decoder (soft)',
    category: 'Digital',
    summary: 'Undoes a rate-½ convolutional code from soft bits — +1 a sure 1, −1 a sure 0, 0 unknown — and puts out the bits it decides.',
    inputs: [{ name: 'soft', kind: REAL, audio: false }],
    outputs: [{ name: 'bits', kind: BITS }],
    params: {
        ...CODE_PARAMS,
        code: { ...CODE_PARAMS.code, default: 'nasa' },
        pairing: ViterbiBlock.params.pairing,
    },
    rate: (inRate) => inRate / 2,
    maxOut: (n) => Math.ceil(n / 2) + 1,
    create() {
        let dec = null;
        let key = '';
        let skip = 0;
        let held = null;
        let pairing = 0;
        const met = new Float64Array(4);
        return {
            configure(p) {
                const c = codeOf(p);
                const k2 = `${c.k}/${c.poly1}/${c.poly2}/${p.pairing}`;
                pairing = p.pairing ? 1 : 0;
                if (k2 !== key) { key = k2; dec = new Viterbi(c); skip = pairing; held = null; }
            },
            reset() { if (dec) dec.reset(); skip = pairing; held = null; },
            latency() { return dec ? dec.depth * 2 : 0; },
            process(ins, outs, n) {
                const x = ins[0].re;
                const out = outs[0].re;
                let m = 0;
                for (let i = 0; i < n; i++) {
                    if (skip) { skip--; continue; }
                    const v = Math.max(-1, Math.min(1, x[i]));
                    if (held === null) { held = v; continue; }
                    const d = dec.step(softScores(held, v, met));
                    held = null;
                    if (d >= 0) out[m++] = d;
                }
                return m;
            },
        };
    },
};
