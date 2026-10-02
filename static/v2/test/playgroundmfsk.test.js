// The MFSK family: Olivia and Contestia, MFSK16 and its kin, DominoEX and
// THOR — each decoded through the playground's blocks from a transmitter
// written here, independently of them, from fldigi's own transmit code
// (~/repos/fldigi/src: pj_mfsk.h's MFSK_Transmitter, mfsk::tx_process,
// dominoex::tx_process, thor::tx_process), and Olivia from real audio that
// Pawel Jalocha's transmitter made (audio_extensions/olivia/testdata).
//
// The character tables here are fldigi's encoding tables; the decoders carry
// fldigi's decoding tables. Each is a check on the other.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const {
    BLOCK_BY_TYPE, makeBuffer, sanitizeParams, Runtime, GRAPH_VERSION, compile, parseGraph, expandDecoder, SNR_BANDWIDTH_HZ,
    Viterbi, CODES, softScores, Interleaver, DominoVaricode, MfskVaricode, binaryCode, walshHadamard, toneGrid,
} = require('./.build/playgroundmfsk.cjs');

let pass = 0;
const t = (name, fn) => {
    const t0 = Date.now();
    try { fn(); console.log(`ok    ${name}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

const graph = (nodes, wires) => parseGraph({ v: GRAPH_VERSION, nodes, wires }).graph;

// ── signals ─────────────────────────────────────────────────────────────────

/** A seeded uniform source, and Gaussian from it (Box–Muller). */
function rng(seed) {
    let s = seed >>> 0 || 1;
    const u = () => {
        s ^= s << 13; s >>>= 0;
        s ^= s >> 17;
        s ^= s << 5; s >>>= 0;
        return (s + 0.5) / 4294967296;
    };
    const g = () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
    return { u, g };
}

/**
 * Continuous-phase tones, `tones` a list of frequencies (Hz) each held
 * `symSec`, at `rate`, as complex baseband; `lead` and `tail` seconds of
 * nothing either side.
 */
function toneSignal(tones, symSec, rate, { lead = 1, tail = 2 } = {}) {
    const n0 = Math.round(lead * rate);
    const n = n0 + Math.ceil(tones.length * symSec * rate) + Math.round(tail * rate);
    const I = new Float32Array(n);
    const Q = new Float32Array(n);
    let ph = 0;
    for (let k = 0; k < tones.length * symSec * rate; k++) {
        const f = tones[Math.min(tones.length - 1, Math.floor(k / (symSec * rate)))];
        I[n0 + k] = Math.cos(ph);
        Q[n0 + k] = Math.sin(ph);
        ph += (2 * Math.PI * f) / rate;
        if (ph > Math.PI) ph -= 2 * Math.PI;
    }
    return { I, Q, n, rate };
}

/**
 * Noise added for `snrDb` in SNR_BANDWIDTH_HZ (2.5 kHz), the signal's power
 * taken from where it is not silent.
 */
function withNoise(sig, snrDb, seed = 7) {
    if (snrDb == null) return sig;
    let p = 0;
    let c = 0;
    for (let k = 0; k < sig.n; k++) {
        const e = sig.I[k] * sig.I[k] + sig.Q[k] * sig.Q[k];
        if (e > 1e-9) { p += e; c++; }
    }
    p /= Math.max(1, c);
    const sigma = Math.sqrt(((p / 10 ** (snrDb / 10)) * (sig.rate / SNR_BANDWIDTH_HZ)) / 2);
    const { g } = rng(seed);
    const I = new Float32Array(sig.n);
    const Q = new Float32Array(sig.n);
    for (let k = 0; k < sig.n; k++) { I[k] = sig.I[k] + sigma * g(); Q[k] = sig.Q[k] + sigma * g(); }
    return { ...sig, I, Q };
}

/** Run a graph over a signal; the console's text. */
function decode(g, sig, consoleId = 'con') {
    const rt = new Runtime(g, sig.rate);
    assert.ok(rt.ok, JSON.stringify(rt.errors));
    const p = Math.round(sig.rate * 0.05);
    for (let at = 0; at < sig.n; at += p) {
        const len = Math.min(p, sig.n - at);
        rt.process({ i: sig.I.subarray(at, at + len), q: sig.Q.subarray(at, at + len), frames: len, rate: sig.rate });
    }
    return { text: rt.read(consoleId).text, rt };
}

/** A one-block decoder at `offsetHz` into a console. */
const oneBlock = (type, params) => graph(
    [{ id: 'iq', type: 'iq-in' }, { id: 'dec', type, params }, { id: 'con', type: 'console' }],
    [['iq', 'out', 'dec', 'in'], ['dec', 'text', 'con', 'in']],
);

/** How many characters of `want` are wrong in `got`, aligned at its best (a plain edit distance). */
function errors(got, want) {
    const a = got;
    const b = want;
    let best = Infinity;
    // Edit distance of want against every substring of got: the cheapest.
    let prev = new Array(a.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
        const cur = [j];
        for (let i = 1; i <= a.length; i++) {
            cur[i] = Math.min(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    for (const v of prev) best = Math.min(best, v);
    return best;
}

// ── fldigi's shared transmit parts ──────────────────────────────────────────

const parity = (x) => { let p = 0; while (x) { p ^= x & 1; x >>>= 1; } return p; };

/** filters/viterbi.cxx encoder: K = 7, 0x6d and 0x4f. */
function encoderK7() {
    let shreg = 0;
    return (bit) => {
        shreg = (shreg << 1) | (bit ? 1 : 0);
        const r = shreg & 127;
        return parity(0x6d & r) | (parity(0x4f & r) << 1);
    };
}

/** mfsk/interleave.cxx, forward, with its bits() wrapper. */
function txInterleaver(size, depth) {
    const table = new Uint8Array(size * size * depth);
    const tab = (i, j, k) => size * size * i + size * j + k;
    return (bits) => {
        const syms = [];
        for (let i = 0; i < size; i++) syms[i] = (bits >> (size - i - 1)) & 1;
        for (let k = 0; k < depth; k++) {
            for (let i = 0; i < size; i++) for (let j = 0; j < size - 1; j++) table[tab(k, i, j)] = table[tab(k, i, j + 1)];
            for (let i = 0; i < size; i++) table[tab(k, i, size - 1)] = syms[i];
            for (let i = 0; i < size; i++) syms[i] = table[tab(k, i, size - i - 1)];
        }
        let out = 0;
        for (let i = 0; i < size; i++) out = (out << 1) | syms[i];
        return out;
    };
}

/** misc.cxx grayencode — which is the inverse Gray code, whatever its name. */
function grayencode(data) {
    let bits = data;
    for (let s = 1; s < 8; s++) bits ^= data >> s;
    return bits & 0xff;
}

// mfskvaricode.cxx varicode[] — IZ8BLY's MFSK Varicode, by character.
const MFSK_VARICODE = [
    '11101011100', '11101100000', '11101101000', '11101101100', '11101110000', '11101110100',
    '11101111000', '11101111100', '10101000', '11110000000', '11110100000', '11110101000',
    '11110101100', '10101100', '11110110000', '11110110100', '11110111000', '11110111100',
    '11111000000', '11111010000', '11111010100', '11111011000', '11111011100', '11111100000',
    '11111101000', '11111101100', '11111110000', '11111110100', '11111111000', '11111111100',
    '100000000000', '101000000000', '100', '111000000', '111111100', '1011011000',
    '1010101000', '1010100000', '1000000000', '110111100', '111110100', '111110000',
    '1010110100', '111100000', '10100000', '111011000', '111010100', '111101000',
    '11100000', '11110000', '101000000', '101010100', '101110100', '101100000',
    '101101100', '110100000', '110000000', '110101100', '111101100', '111111000',
    '1011000000', '111011100', '1010111100', '111010000', '1010000000', '10111100',
    '100000000', '11010100', '11011100', '10111000', '11111000', '101010000',
    '101011000', '11000000', '110110100', '101111100', '11110100', '11101000',
    '11111100', '11010000', '11101100', '110110000', '11011000', '10110100',
    '10110000', '101011100', '110101000', '101101000', '101110000', '101111000',
    '110111000', '1011101000', '1011010000', '1011101100', '1011010100', '1010110000',
    '1010101100', '10100', '1100000', '111000', '110100', '1000',
    '1010000', '1011000', '110000', '11000', '10000000', '1110000',
    '101100', '1000000', '11100', '10000', '1010100', '1111000',
    '100000', '101000', '1100', '111100', '1101100', '1101000',
    '1110100', '1011100', '1111100', '1011011100', '1010111000', '1011100000',
    '1011110000', '101010000000', '101010100000', '101010101000', '101010101100', '101010110000',
    '101010110100', '101010111000', '101010111100', '101011000000', '101011010000', '101011010100',
    '101011011000', '101011011100', '101011100000', '101011101000', '101011101100', '101011110000',
    '101011110100', '101011111000', '101011111100', '101100000000', '101101000000', '101101010000',
    '101101010100', '101101011000', '101101011100', '101101100000', '101101101000', '101101101100',
    '101101110000', '101101110100', '101101111000', '101101111100', '1011110100', '1011111000',
    '1011111100', '1100000000', '1101000000', '1101010000', '1101010100', '1101011000',
    '1101011100', '1101100000', '1101101000', '1101101100', '1101110000', '1101110100',
    '1101111000', '1101111100', '1110000000', '1110100000', '1110101000', '1110101100',
    '1110110000', '1110110100', '1110111000', '1110111100', '1111000000', '1111010000',
    '1111010100', '1111011000', '1111011100', '1111100000', '1111101000', '1111101100',
    '1111110000', '1111110100', '1111111000', '1111111100', '10000000000', '10100000000',
    '10101000000', '10101010000', '10101010100', '10101011000', '10101011100', '10101100000',
    '10101101000', '10101101100', '10101110000', '10101110100', '10101111000', '10101111100',
    '10110000000', '10110100000', '10110101000', '10110101100', '10110110000', '10110110100',
    '10110111000', '10110111100', '10111000000', '10111010000', '10111010100', '10111011000',
    '10111011100', '10111100000', '10111101000', '10111101100', '10111110000', '10111110100',
    '10111111000', '10111111100', '11000000000', '11010000000', '11010100000', '11010101000',
    '11010101100', '11010110000', '11010110100', '11010111000', '11010111100', '11011000000',
    '11011010000', '11011010100', '11011011000', '11011011100', '11011100000', '11011101000',
    '11011101100', '11011110000', '11011110100', '11011111000', '11011111100', '11100000000',
    '11101000000', '11101010000', '11101010100', '11101011000',
];
// thorvaricode.cxx thor_varicode[] — THOR's second alphabet, ' ' to 'z'.
const THOR_VARICODE = [
    '101110000000', '101110100000', '101110101000', '101110101100', '101110110000', '101110110100',
    '101110111000', '101110111100', '101111000000', '101111010000', '101111010100', '101111011000',
    '101111011100', '101111100000', '101111101000', '101111101100', '101111110000', '101111110100',
    '101111111000', '101111111100', '110000000000', '110100000000', '110101000000', '110101010100',
    '110101011000', '110101011100', '110101100000', '110101101000', '110101101100', '110101110000',
    '110101110100', '110101111000', '110101111100', '110110000000', '110110100000', '110110101000',
    '110110101100', '110110110000', '110110110100', '110110111000', '110110111100', '110111000000',
    '110111010000', '110111010100', '110111011000', '110111011100', '110111100000', '110111101000',
    '110111101100', '110111110000', '110111110100', '110111111000', '110111111100', '111000000000',
    '111010000000', '111010100000', '111010101100', '111010110000', '111010110100', '111010111000',
    '111010111100', '111011000000', '111011010000', '111011010100', '111011011000', '111011011100',
    '111011100000', '111011101000', '111011101100', '111011110000', '111011110100', '111011111000',
    '111011111100', '111100000000', '111101000000', '111101010000', '111101010100', '111101011000',
    '111101011100', '111101100000', '111101101000', '111101101100', '111101110000', '111101110100',
    '111101111000', '111101111100', '111110000000', '111110100000', '111110101000', '111110101100',
    '111110110000',
];
// dominovar.cxx varicode[][3], each entry's three nibbles in hex: 256 primary
// then 256 secondary.
const DOMINO_VARICODE = [
    '1f9', '1fa', '1fb', '1fc', '1fd', '1fe', '1ff', '288', '2c0', '289', '28a', '28b', '28c', '2d0', '28d', '28e',
    '28f', '298', '299', '29a', '29b', '29c', '29d', '29e', '29f', '2a8', '2a9', '2aa', '2ab', '2ac', '2ad', '2ae',
    '000', '7b0', '08e', '0ab', '09a', '099', '08f', '7a0', '08c', '08b', '09d', '088', '2b0', '7e0', '7d0', '089',
    '3f0', '4a0', '4f0', '590', '680', '5c0', '5e0', '6c0', '6b0', '6e0', '08a', '08d', '0a8', '7f0', '09f', '7c0',
    '098', '390', '4e0', '3c0', '3e0', '380', '4c0', '580', '5a0', '3a0', '780', '6a0', '4b0', '480', '4d0', '3b0',
    '490', '6f0', '3d0', '2f0', '2e0', '5b0', '6d0', '5d0', '5f0', '690', '790', '0ae', '0a9', '0af', '0aa', '09c',
    '09b', '400', '1b0', '0c0', '0b0', '100', '0f0', '190', '0a0', '500', '2a0', '1e0', '090', '0e0', '600', '300',
    '180', '280', '700', '080', '200', '0d0', '1d0', '1c0', '1f0', '1a0', '290', '0ac', '09e', '0ad', '0b8', '2af',
    '2b8', '2b9', '2ba', '2bb', '2bc', '2bd', '2be', '2bf', '2c8', '2c9', '2ca', '2cb', '2cc', '2cd', '2ce', '2cf',
    '2d8', '2d9', '2da', '2db', '2dc', '2dd', '2de', '2df', '2e8', '2e9', '2ea', '2eb', '2ec', '2ed', '2ee', '2ef',
    '0b9', '0ba', '0bb', '0bc', '0bd', '0be', '0bf', '0c8', '0c9', '0ca', '0cb', '0cc', '0cd', '0ce', '0cf', '0d8',
    '0d9', '0da', '0db', '0dc', '0dd', '0de', '0df', '0e8', '0e9', '0ea', '0eb', '0ec', '0ed', '0ee', '0ef', '0f8',
    '0f9', '0fa', '0fb', '0fc', '0fd', '0fe', '0ff', '188', '189', '18a', '18b', '18c', '18d', '18e', '18f', '198',
    '199', '19a', '19b', '19c', '19d', '19e', '19f', '1a8', '1a9', '1aa', '1ab', '1ac', '1ad', '1ae', '1af', '1b8',
    '1b9', '1ba', '1bb', '1bc', '1bd', '1be', '1bf', '1c8', '1c9', '1ca', '1cb', '1cc', '1cd', '1ce', '1cf', '1d8',
    '1d9', '1da', '1db', '1dc', '1dd', '1de', '1df', '1e8', '1e9', '1ea', '1eb', '1ec', '1ed', '1ee', '1ef', '1f8',
    '6f9', '6fa', '6fb', '6fc', '6fd', '6fe', '6ff', '788', '4ac', '789', '78a', '78b', '78c', '4ad', '78d', '78e',
    '78f', '798', '799', '79a', '79b', '79c', '79d', '79e', '79f', '7a8', '7a9', '7aa', '7ab', '7ac', '7ad', '7ae',
    '388', '4fb', '58e', '5ab', '59a', '599', '58f', '4fa', '58c', '58b', '59d', '588', '4ab', '4fe', '4fd', '589',
    '4bf', '4ca', '4cf', '4d9', '4e8', '4dc', '4de', '4ec', '4eb', '4ee', '58a', '58d', '5a8', '4ff', '59f', '4fc',
    '598', '4b9', '4ce', '4bc', '4be', '4b8', '4cc', '4d8', '4da', '4ba', '4f8', '4ea', '4cb', '4c8', '4cd', '4bb',
    '4c9', '4ef', '4bd', '4af', '4ae', '4db', '4ed', '4dd', '4df', '4e9', '4f9', '5ae', '5a9', '5af', '5aa', '59c',
    '59b', '38c', '49b', '48c', '48b', '389', '48f', '499', '48a', '38d', '4aa', '49e', '489', '48e', '38e', '38b',
    '498', '4a8', '38f', '488', '38a', '48d', '49d', '49c', '49f', '49a', '4a9', '5ac', '59e', '5ac', '5b8', '7af',
    '7b8', '7b9', '7ba', '7bb', '7bc', '7bd', '7be', '7bf', '7c8', '7c9', '7ca', '7cb', '7cc', '7cd', '7ce', '7cf',
    '7d8', '7d9', '7da', '7db', '7dc', '7dd', '7de', '7df', '7e8', '7e9', '7ea', '7eb', '7ec', '7ed', '7ee', '7ef',
    '5b9', '5ba', '5bb', '5bc', '5bd', '5be', '5bf', '5c8', '5c9', '5ca', '5cb', '5cc', '5cd', '5ce', '5cf', '5d8',
    '5d9', '5da', '5db', '5dc', '5dd', '5de', '5df', '5e8', '5e9', '5ea', '5eb', '5ec', '5ed', '5ee', '5ef', '5f8',
    '5f9', '5fa', '5fb', '5fc', '5fd', '5fe', '5ff', '688', '689', '68a', '68b', '68c', '68d', '68e', '68f', '698',
    '699', '69a', '69b', '69c', '69d', '69e', '69f', '6a8', '6a9', '6aa', '6ab', '6ac', '6ad', '6ae', '6af', '6b8',
    '6b9', '6ba', '6bb', '6bc', '6bd', '6be', '6bf', '6c8', '6c9', '6ca', '6cb', '6cc', '6cd', '6ce', '6cf', '6d8',
    '6d9', '6da', '6db', '6dc', '6dd', '6de', '6df', '6e8', '6e9', '6ea', '6eb', '6ec', '6ed', '6ee', '6ef', '6f8',
];

// ── MFSK16 and kin: mfsk::tx_process ────────────────────────────────────────

const MFSK = {
    mfsk16: { rate: 8000, symlen: 512, depth: 10, preamble: 107 },
    mfsk32: { rate: 8000, symlen: 256, depth: 10, preamble: 107 },
    mfsk64: { rate: 8000, symlen: 128, depth: 10, preamble: 180 },
    mfsk128: { rate: 8000, symlen: 64, depth: 20, preamble: 214 },
    mfsk11: { rate: 11025, symlen: 1024, depth: 10, preamble: 107 },
    mfsk22: { rate: 11025, symlen: 512, depth: 10, preamble: 107 },
};

function mfskTx(text, { mode = 'mfsk16', centre = 1000, rate = 8000 } = {}) {
    const m = MFSK[mode];
    const symbits = 4;
    const numtones = 16;
    const spacing = m.rate / m.symlen;
    const bandwidth = (numtones - 1) * spacing;
    const enc = encoderK7();
    const inlv = txInterleaver(symbits, m.depth);
    const tones = [];
    let bitshreg = 0;
    let bitstate = 0;
    const sendsymbol = (sym) => {
        const s = grayencode(sym & (numtones - 1));
        tones.push(centre - bandwidth / 2 + s * spacing);
    };
    const push = (data, send) => {
        for (let i = 0; i < 2; i++) {
            bitshreg = (bitshreg << 1) | ((data >> i) & 1);
            if (++bitstate === symbits) {
                const b = inlv(bitshreg);
                if (send) sendsymbol(b);
                bitstate = 0;
                bitshreg = 0;
            }
        }
    };
    const sendbit = (bit) => push(enc(bit), true);
    const sendchar = (c) => { for (const b of MFSK_VARICODE[c]) sendbit(b === '1' ? 1 : 0); };
    // TX_STATE_PREAMBLE: clearbits() (one encoded 0, its pair fed to the
    // interleaver `preamble` times, nothing sent), then a third as many 0s sent.
    const zero = enc(0);
    for (let k = 0; k < m.preamble; k++) push(zero, false);
    for (let i = 0; i < Math.floor(m.preamble / 3); i++) sendbit(0);
    for (const c of [13, 2, 13]) sendchar(c);
    for (const ch of text) sendchar(ch.charCodeAt(0));
    // TX_STATE_FLUSH.
    for (const c of [13, 4, 13]) sendchar(c);
    sendbit(1);
    for (let i = 0; i < m.preamble; i++) sendbit(0);
    return toneSignal(tones, m.symlen / m.rate, rate);
}

// ── DominoEX: dominoex::tx_process ──────────────────────────────────────────

const IFK = {
    4: { rate: 8000, symlen: 2048, double: 2 },
    5: { rate: 11025, symlen: 2048, double: 2 },
    8: { rate: 8000, symlen: 1024, double: 2 },
    11: { rate: 11025, symlen: 1024, double: 1 },
    16: { rate: 8000, symlen: 512, double: 1 },
    22: { rate: 11025, symlen: 512, double: 1 },
};

/** dominoex::sendsymbol / thor::sendsymbol: the tone list, IFK+. */
function ifkTones(m, centre) {
    const spacing = (m.rate * m.double) / m.symlen;
    const bandwidth = 18 * spacing;
    const tones = [];
    let prev = 0;
    return {
        tones,
        send(sym) {
            const tone = (prev + 2 + sym) % 18;
            prev = tone;
            tones.push((tone + 0.5) * spacing + centre - bandwidth / 2);
        },
    };
}

function dominoTx(text, { mode = '16', centre = 1000, rate = 8000, idle = '' } = {}) {
    const m = IFK[mode];
    const ifk = ifkTones(m, centre);
    const sendchar = (c, secondary = 0) => {
        const code = DOMINO_VARICODE[c + (secondary ? 256 : 0)].split('').map((h) => parseInt(h, 16));
        ifk.send(code[0]);
        for (let s = 1; s < 3; s++) {
            if (code[s] & 8) ifk.send(code[s]);
            else break;
        }
    };
    sendchar(0, 1);
    for (const c of [13, 2, 13]) sendchar(c);
    for (const ch of text) sendchar(ch.charCodeAt(0));
    // Nothing to send: the secondary text, as dominoex::sendsecondary does.
    for (const ch of idle) sendchar(ch.charCodeAt(0), 1);
    for (const c of [13, 4, 13]) sendchar(c);
    for (let i = 0; i < 4; i++) sendchar(0, 1);
    return toneSignal(ifk.tones, m.symlen / m.rate, rate);
}

// ── THOR: thor::tx_process ──────────────────────────────────────────────────

function thorTx(text, { mode = '16', centre = 1000, rate = 8000, idle = '' } = {}) {
    const m = IFK[mode];
    const ifk = ifkTones(m, centre);
    const enc = encoderK7();
    const inlv = txInterleaver(4, 10);
    let bitshreg = 0;
    let bitstate = 0;
    const push = (data, send) => {
        for (let i = 0; i < 2; i++) {
            bitshreg = (bitshreg << 1) | ((data >> i) & 1);
            if (++bitstate === 4) {
                const b = inlv(bitshreg);
                if (send) ifk.send(b);
                bitstate = 0;
                bitshreg = 0;
            }
        }
    };
    const sendchar = (c, secondary = 0) => {
        const code = secondary ? THOR_VARICODE[c - 32] : MFSK_VARICODE[c];
        for (const b of code) push(enc(b === '1' ? 1 : 0), true);
    };
    // Clearbits: one encoded 0, its pair into the interleaver 1400 times.
    const zero = enc(0);
    for (let k = 0; k < 1400; k++) push(zero, false);
    for (let j = 0; j < 16; j++) ifk.send(0);
    sendchar(0);
    for (const c of [13, 2, 13]) sendchar(c);
    for (const ch of text) sendchar(ch.charCodeAt(0));
    for (const ch of idle) sendchar(ch.charCodeAt(0), 1);
    for (const c of [13, 4, 13]) sendchar(c);
    for (let i = 0; i < 4; i++) sendchar(0);
    return toneSignal(ifk.tones, m.symlen / m.rate, rate);
}

// ── Olivia and Contestia: pj_mfsk.h MFSK_Transmitter ────────────────────────

/**
 * Olivia (or Contestia) at 8 kHz, as complex baseband: MFSK_Encoder,
 * MFSK_Modulator and MFSK_Transmitter::Output, with the modulator's cosine
 * table made a complex exponential. Centred where olivia::restart puts
 * FirstCarrier for `centre` (contestia::restart for Contestia). `idleBlocks`
 * blocks of NUL follow the text, as fldigi sends while nothing is typed.
 */
function oliviaTx(text, { tones = 8, bw = 250, centre = 1500, contestia = false, idleBlocks = 6, seed = 3, lead = 1, tail = 1 } = {}) {
    const rate = 8000;
    const bps = Math.round(Math.log2(tones));
    const symbolLen = 1 << (bps + 7 - Math.round(Math.log2(bw / 125)));
    const separ = symbolLen / 2;
    const fcOffset = contestia ? bw / 2 : (bw * (1 - 0.5 / tones)) / 2;
    const firstCarrier = Math.floor((symbolLen / 16) * ((centre - fcOffset) / 500)) + 1;
    const bpc = contestia ? 6 : 7;
    const perBlock = 1 << (bpc - 1);
    const scramble = contestia ? [0, 0xEDB88320] : [0xE257E6D0, 0x291574EC];
    const codeBit = (i) => ((i < 32 ? scramble[1] >>> i : scramble[0] >>> (i - 32)) & 1);
    const nShift = contestia ? 5 : 13;
    const fht = new Float64Array(perBlock);
    // pj_fht.h IFHT.
    const ifht = (d, len) => {
        for (let step = len >> 1; step; step >>= 1) {
            for (let ptr = 0; ptr < len; ptr += 2 * step) {
                for (let p = ptr; p - ptr < step; p++) {
                    const a = d[p];
                    const b = d[p + step];
                    d[p] = a - b;
                    d[p + step] = a + b;
                }
            }
        }
    };
    const encodeChar = (ch) => {
        let c = ch;
        if (contestia) {
            if (c >= 97 && c <= 122) c -= 32;
            if (c === 32) c = 59;
            else if (c === 13) c = 60;
            else if (c === 10) c = 0;
            else if (c >= 33 && c <= 90) c -= 32;
            else if (c === 8) c = 61;
            else if (c === 0) c = 0;
            else c = 63 - 32;
        } else {
            c &= perBlock * 2 - 1;
        }
        fht.fill(0);
        if (c < perBlock) fht[c] = 1; else fht[c - perBlock] = -1;
        ifht(fht, perBlock);
    };
    const encodeBlock = (chars) => {
        const out = new Uint8Array(perBlock);
        for (let fb = 0; fb < bps; fb++) {
            encodeChar(chars[fb]);
            // ScrambleFHT(fb × nShift).
            let cb = (fb * nShift) & (perBlock - 1);
            for (let tb = 0; tb < perBlock; tb++) {
                if (codeBit(cb)) fht[tb] = -fht[tb];
                cb = (cb + 1) & (perBlock - 1);
            }
            let rot = 0;
            for (let tb = 0; tb < perBlock; tb++) {
                if (fht[tb] < 0) {
                    let bit = fb + rot;
                    if (bit >= bps) bit -= bps;
                    out[tb] |= 1 << bit;
                }
                if (++rot >= bps) rot -= bps;
            }
        }
        return out;
    };
    // The modulator.
    const mask = symbolLen - 1;
    const tapRe = new Float64Array(symbolLen);
    const tapIm = new Float64Array(symbolLen);
    let tapPtr = 0;
    let phase = 0;
    const { u } = rng(seed);
    const outRe = [];
    const outIm = [];
    const send = (symbol) => {
        const freq = firstCarrier + 2 * (symbol ^ (symbol >> 1));
        phase = (phase + freq * (separ / 2 - symbolLen / 2)) & mask;
        let ph = phase;
        for (let tm = 0; tm < symbolLen; tm++) {
            const shape = 1 - Math.cos((2 * Math.PI * tm) / symbolLen);
            tapRe[tapPtr] += Math.cos((2 * Math.PI * ph) / symbolLen) * shape;
            tapIm[tapPtr] += Math.sin((2 * Math.PI * ph) / symbolLen) * shape;
            ph = (ph + freq) & mask;
            tapPtr = (tapPtr + 1) & mask;
        }
        phase = (phase + freq * (separ / 2 + symbolLen / 2)) & mask;
        phase = (phase + (u() < 0.5 ? -1 : 1) * (symbolLen / 4)) & mask;
    };
    const output = () => {
        for (let i = 0; i < separ; i++) {
            outRe.push(tapRe[tapPtr]);
            outIm.push(tapIm[tapPtr]);
            tapRe[tapPtr] = 0;
            tapIm[tapPtr] = 0;
            tapPtr = (tapPtr + 1) & mask;
        }
    };
    // olivia::tx_process puts a NUL in first; the text after it, then idle.
    const queue = [0, ...Array.from(text, (ch) => ch.charCodeAt(0))];
    for (let i = 0; i < idleBlocks * bps; i++) queue.push(0);
    while (queue.length) {
        const chars = queue.splice(0, bps);
        while (chars.length < bps) chars.push(0);
        const block = encodeBlock(chars);
        for (let s = 0; s < perBlock; s++) { send(block[s]); output(); }
    }
    output(); output();
    const n0 = Math.round(lead * rate);
    const n = n0 + outRe.length + Math.round(tail * rate);
    const I = new Float32Array(n);
    const Q = new Float32Array(n);
    let peak = 0;
    for (let k = 0; k < outRe.length; k++) peak = Math.max(peak, Math.hypot(outRe[k], outIm[k]));
    for (let k = 0; k < outRe.length; k++) { I[n0 + k] = outRe[k] / peak; Q[n0 + k] = outIm[k] / peak; }
    return { I, Q, n, rate, centre: (firstCarrier + tones - 1) * (rate / symbolLen) };
}

/** A signal moved up by `hz`. */
function moved(sig, hz) {
    const I = new Float32Array(sig.n);
    const Q = new Float32Array(sig.n);
    for (let k = 0; k < sig.n; k++) {
        const c = Math.cos((2 * Math.PI * hz * k) / sig.rate);
        const s = Math.sin((2 * Math.PI * hz * k) / sig.rate);
        I[k] = sig.I[k] * c - sig.Q[k] * s;
        Q[k] = sig.I[k] * s + sig.Q[k] * c;
    }
    return { ...sig, I, Q };
}

const MSG = 'CQ CQ DE M9PSY M9PSY PSE K';

// ── the parts ───────────────────────────────────────────────────────────────

t('the interleaver: deinterleaving undoes fldigi\'s interleaving, a symbol at a time', () => {
    const fwd = txInterleaver(4, 10);
    const rev = new Interleaver(4, 10, false, -9);
    const { u } = rng(11);
    const sent = Array.from({ length: 300 }, () => Math.floor(u() * 16));
    const got = sent.map((s) => {
        const b = fwd(s);
        const syms = [3, 2, 1, 0].map((k) => (b >> k) & 1);
        rev.symbols(syms);
        return syms;
    });
    // Each bit comes out (size × depth) symbols' worth of bits later...
    const flat = got.flat();
    const want = sent.flatMap((s) => [3, 2, 1, 0].map((k) => (s >> k) & 1));
    let lag = -1;
    for (let L = 0; L < 400 && lag < 0; L++) if (want.slice(0, 600).every((b, i) => flat[i + L] === b)) lag = L;
    assert.ok(lag > 0, 'never lines up');
    // ...and before that, the receiver's "don't know".
    assert.ok(flat.slice(0, 3).every((v) => v === -9));
});

t('the soft Viterbi decoder: what the K = 7 encoder sent, through soft errors', () => {
    const enc = encoderK7();
    const dec = new Viterbi(CODES.nasa);
    const { u, g } = rng(5);
    const bits = Array.from({ length: 2000 }, () => (u() < 0.5 ? 1 : 0));
    const out = [];
    const met = new Float64Array(4);
    for (const b of [...bits, ...new Array(100).fill(0)]) {
        const pair = enc(b);
        // ±1 with noise of σ 0.8 — a raw bit error rate near 11%.
        const v0 = ((pair & 1) ? 1 : -1) + 0.8 * g();
        const v1 = ((pair & 2) ? 1 : -1) + 0.8 * g();
        const d = dec.step(softScores(v0, v1, met));
        if (d >= 0) out.push(d);
    }
    const wrong = bits.reduce((s, b, i) => s + (b !== out[i] ? 1 : 0), 0);
    assert.ok(wrong <= 4, `${wrong} wrong`);
});

t('MFSK Varicode: every character of fldigi\'s table, and THOR\'s second alphabet', () => {
    const dec = new MfskVaricode(true);
    const got = [];
    const feed = (code) => { for (const b of code) { const c = dec.push(b === '1' ? 1 : 0); if (c >= 0) got.push(c); } };
    // Run together, as sent: each code's own trailing zeros are the gap.
    // Idle zeros first, as fldigi's preamble, to clear the register.
    feed('0'.repeat(40));
    for (let c = 0; c < 256; c++) feed(MFSK_VARICODE[c]);
    for (let i = 0; i < THOR_VARICODE.length; i++) feed(THOR_VARICODE[i]);
    feed('1');
    const want = [...Array.from({ length: 256 }, (_, c) => c), ...THOR_VARICODE.map((_, i) => 0x120 + i)];
    assert.deepStrictEqual(got, want);
});

t('DominoEX Varicode: every character of fldigi\'s table, primary and secondary', () => {
    const dec = new DominoVaricode();
    const got = [];
    for (let c = 0; c < 512; c++) {
        const nib = DOMINO_VARICODE[c].split('').map((h) => parseInt(h, 16));
        const code = [nib[0]];
        for (let s = 1; s < 3 && (nib[s] & 8); s++) code.push(nib[s]);
        for (const x of code) { const ch = dec.push(x); if (ch >= 0) got.push(ch); }
    }
    got.push(dec.push(0));
    // Two secondary characters share a code in fldigi's table, which decodes
    // as the second of them: the one place the round trip cannot hold.
    const want = Array.from({ length: 512 }, (_, c) => (c === 379 ? 381 : c));
    assert.deepStrictEqual(got, want);
});

t('Olivia\'s Hadamard transform and Gray code: the reference\'s, from its own vectors', () => {
    const file = path.join(__dirname, '../../../audio_extensions/olivia/testdata/vectors.json');
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (let i = 0; i < 256; i++) assert.strictEqual(binaryCode(i), v.binary_code[i]);
    for (const f of v.fht) {
        const d = Float64Array.from(f.in);
        walshHadamard(d, d.length);
        d.forEach((x, i) => assert.ok(Math.abs(x - f.out[i]) < 1e-9));
    }
});

t('tone detector: a row\'s points, and a tone reads 1 on its own point', () => {
    assert.deepStrictEqual(toneGrid({ tones: 8, oversample: 2, margin: 4 }), { os: 2, first: 8, size: 31, centre: 15 });
    assert.strictEqual(toneGrid({ tones: 18, oversample: 5, margin: 9 }).size, 176);
    const def = BLOCK_BY_TYPE['mfsk-detector'];
    const p = sanitizeParams(def, { tones: 16, spacingHz: 15.625, baud: 15.625, afc: false });
    assert.strictEqual(def.rate(8000, p), 15.625 * 16);
    const inst = def.create();
    inst.configure(p, 8000);
    // Tone 11 of 16: (11 − 7.5) × 15.625 Hz.
    const sig = toneSignal(new Array(40).fill(3.5 * 15.625), 512 / 8000, 8000, { lead: 0, tail: 0 });
    const inb = makeBuffer('complex', sig.n);
    inb.re.set(sig.I); inb.im.set(sig.Q);
    const out = makeBuffer('real', def.maxOut(sig.n, p, 8000));
    const m = inst.process([inb], [out], sig.n);
    assert.ok(m >= 16 * 30, `${m / 16} frames`);
    const f = out.re.subarray(m - 32, m - 16);
    assert.ok(Math.abs(f[11] - 1) < 0.02, `power ${f[11]}`);
    assert.ok(f.every((x, i) => i === 11 || x < 0.01));
});

// ── Olivia ──────────────────────────────────────────────────────────────────

/** Real Olivia from the reference's own transmitter: 12 kHz, real, 8-bit, centred on 1000 Hz. */
function oliviaRecording(name) {
    const dir = path.join(__dirname, '../../../audio_extensions/olivia/testdata');
    const v = JSON.parse(fs.readFileSync(path.join(dir, 'vectors.json'), 'utf8')).audio.find((a) => a.name === name);
    const raw = zlib.gunzipSync(fs.readFileSync(path.join(dir, `${v.file}.gz`)));
    // The transmission ends as it ends; the receiver wants a few blocks more
    // to finish deciding, as the reference's own Flush gives it.
    const rate = v.sample_rate;
    const n = raw.length + rate * 12;
    const I = new Float32Array(n);
    const Q = new Float32Array(n);
    for (let k = 0; k < raw.length; k++) I[k] = ((raw[k] << 24) >> 24) / 128;
    return { sig: { I, Q, n, rate }, v };
}

for (const name of ['olivia_8_250', 'olivia_16_500', 'olivia_32_1000']) {
    t(`Olivia: real audio from the reference transmitter, ${name.slice(7).replace('_', '/')}`, () => {
        const { sig, v } = oliviaRecording(name);
        const g = oneBlock('olivia-decoder', { offsetHz: v.center_hz, tones: v.tones, bandwidth: v.bandwidth });
        const { text } = decode(g, sig);
        assert.ok(text.includes(v.sent), JSON.stringify(text));
    });
}

const OLIVIA_MODES = [[8, 250], [8, 500], [16, 500], [32, 1000], [4, 125]];

for (const [tones, bw] of OLIVIA_MODES) {
    t(`Olivia ${tones}/${bw}: clean, and at −12 dB`, () => {
        const sig = oliviaTx(MSG, { tones, bw, centre: 1500 });
        const g = oneBlock('olivia-decoder', { offsetHz: 1500, tones, bandwidth: bw });
        const clean = decode(g, sig).text;
        assert.ok(clean.includes(MSG), JSON.stringify(clean));
        // In noise the search can take a block longer to be sure, and the
        // first characters go, as in fldigi.
        const noisy = decode(g, withNoise(sig, -12)).text;
        assert.ok(errors(noisy, MSG) <= 3, JSON.stringify(noisy));
    });
}

t('Olivia 8/250 at −14 dB, and 32/1000 at −13 dB, over three noise seeds', () => {
    for (const [tones, bw, snr] of [[8, 250, -14], [32, 1000, -13]]) {
        const sig = oliviaTx(MSG, { tones, bw, centre: 1500 });
        const g = oneBlock('olivia-decoder', { offsetHz: 1500, tones, bandwidth: bw });
        let wrong = 0;
        for (const seed of [1, 2, 3]) wrong += errors(decode(g, withNoise(sig, snr, seed)).text, MSG);
        assert.ok(wrong <= 4, `${tones}/${bw} at ${snr} dB: ${wrong} characters wrong in three`);
    }
});

t('Olivia 8/250 finds a signal anywhere in its search margin (±125 Hz): −100 and +110 Hz off, at −8 dB', () => {
    for (const off of [-100, 110]) {
        const sig = withNoise(moved(oliviaTx(MSG, { tones: 8, bw: 250, centre: 1500 }), off), -8);
        const { text } = decode(oneBlock('olivia-decoder', { offsetHz: 1500, tones: 8, bandwidth: 250 }), sig);
        assert.ok(text.includes(MSG), `${off}: ${JSON.stringify(text)}`);
    }
});

for (const [tones, bw] of [[8, 250], [4, 125], [16, 500]]) {
    t(`Contestia ${tones}/${bw}: clean, and at −10 dB`, () => {
        const sig = oliviaTx(MSG, { tones, bw, centre: 1500, contestia: true });
        const g = oneBlock('olivia-decoder', { offsetHz: 1500, tones, bandwidth: bw, mode: 'contestia' });
        for (const s of [sig, withNoise(sig, -10)]) {
            const { text } = decode(g, s);
            assert.ok(text.includes(MSG), JSON.stringify(text));
        }
    });
}

t('Olivia\'s squelch: two minutes of plain noise print nothing', () => {
    const n = 8000 * 120;
    const { g } = rng(9);
    const I = new Float32Array(n);
    const Q = new Float32Array(n);
    for (let k = 0; k < n; k++) { I[k] = g(); Q[k] = g(); }
    const { text } = decode(oneBlock('olivia-decoder', { offsetHz: 1500 }), { I, Q, n, rate: 8000 });
    assert.strictEqual(text, '');
});

t('Olivia FEC reports the S/N and how far off the signal is', () => {
    const all = withNoise(moved(oliviaTx(MSG, { tones: 8, bw: 250, centre: 1500 }), 31.25), -5);
    // Read while the signal is still there.
    const n = Math.round(all.n * 0.6);
    const sig = { ...all, I: all.I.subarray(0, n), Q: all.Q.subarray(0, n), n };
    const g = oneBlock('olivia-decoder', { offsetHz: 1500 });
    const { graph: x } = expandDecoder(g, 'dec');
    const { rt } = decode(x, sig);
    const r = rt.read('dec_fec');
    assert.ok(r.snr > 5, `S/N ${r.snr}`);
    // Two half-tone steps up: 31.25 Hz.
    assert.ok(Math.abs(r.offsetHz - 31.25) < 1, `offset ${r.offsetHz}`);
});

// ── MFSK16 and kin ──────────────────────────────────────────────────────────

for (const mode of Object.keys(MFSK)) {
    t(`${mode.toUpperCase()}: clean`, () => {
        const { text } = decode(oneBlock('mfsk-decoder', { offsetHz: 1500, mode }), mfskTx(MSG, { mode, centre: 1500 }));
        assert.ok(text.includes(`\n${MSG}\n`), JSON.stringify(text));
    });
}

t('MFSK16 at −10 dB and MFSK32 at −8 dB, over three noise seeds', () => {
    for (const [mode, snr] of [['mfsk16', -10], ['mfsk32', -8]]) {
        const sig = mfskTx(MSG, { mode, centre: 1500 });
        let wrong = 0;
        for (const seed of [1, 2, 3]) wrong += errors(decode(oneBlock('mfsk-decoder', { offsetHz: 1500, mode }), withNoise(sig, snr, seed)).text, MSG);
        assert.ok(wrong <= 2, `${mode} at ${snr} dB: ${wrong} characters wrong in three`);
    }
});

t('MFSK16: AFC pulls in a signal 6 Hz off (most of half a tone), at −6 dB', () => {
    for (const off of [-6, 6]) {
        const sig = withNoise(moved(mfskTx(MSG, { mode: 'mfsk16', centre: 1500 }), off), -6);
        const g = oneBlock('mfsk-decoder', { offsetHz: 1500, mode: 'mfsk16' });
        const { graph: x } = expandDecoder(g, 'dec');
        const { text, rt } = decode(x, sig);
        assert.ok(text.includes(MSG), `${off}: ${JSON.stringify(text)}`);
        const afc = rt.read('dec_tones').afcHz;
        assert.ok(Math.abs(afc - off) < 1, `AFC at ${afc}`);
    }
});

t('MFSK16 at a 12 kHz stream rate', () => {
    const { text } = decode(oneBlock('mfsk-decoder', { offsetHz: 1200, mode: 'mfsk16' }), withNoise(mfskTx(MSG, { centre: 1200, rate: 12000 }), -6));
    assert.ok(text.includes(MSG), JSON.stringify(text));
});

// ── DominoEX ────────────────────────────────────────────────────────────────

for (const mode of Object.keys(IFK)) {
    t(`DominoEX ${mode}: clean`, () => {
        const { text } = decode(oneBlock('dominoex-decoder', { offsetHz: 1500, mode }), dominoTx(MSG, { mode, centre: 1500, idle: 'UBERSDR ' }));
        assert.ok(text.includes(`\n${MSG}\n`), JSON.stringify(text));
    });
}

t('DominoEX 16 at −8 dB and DominoEX 11 at −11 dB, over three noise seeds', () => {
    for (const [mode, snr] of [['16', -8], ['11', -11]]) {
        const sig = dominoTx(MSG, { mode, centre: 1500, idle: 'UBERSDR ' });
        let wrong = 0;
        for (const seed of [1, 2, 3]) wrong += errors(decode(oneBlock('dominoex-decoder', { offsetHz: 1500, mode }), withNoise(sig, snr, seed)).text, MSG);
        assert.ok(wrong <= 2, `DominoEX ${mode} at ${snr} dB: ${wrong} characters wrong in three`);
    }
});

t('DominoEX 16 needs no tuning: −120 and +130 Hz off (eight tones), at −4 dB', () => {
    for (const off of [-120, 130]) {
        const sig = withNoise(moved(dominoTx(MSG, { mode: '16', centre: 1500, idle: 'UBERSDR ' }), off), -4);
        const { text } = decode(oneBlock('dominoex-decoder', { offsetHz: 1500, mode: '16' }), sig);
        assert.ok(text.includes(MSG), `${off}: ${JSON.stringify(text)}`);
    }
});

t('DominoEX: the idle text comes out on the second port, and not in the first', () => {
    const sig = dominoTx(MSG, { mode: '11', centre: 1500, idle: 'UBERSDR UBERSDR ' });
    const { graph: x } = expandDecoder(oneBlock('dominoex-decoder', { offsetHz: 1500, mode: '11' }), 'dec');
    x.nodes.push({ id: 'sec', type: 'console', params: {}, x: 0, y: 0 });
    x.wires.push(['dec_varicode', 'secondary', 'sec', 'in']);
    const { text, rt } = decode(graph(x.nodes, x.wires), sig);
    assert.ok(rt.read('sec').text.includes('UBERSDR UBERSDR'), JSON.stringify(rt.read('sec').text));
    assert.ok(!text.includes('UBERSDR'), JSON.stringify(text));
});

// ── THOR ────────────────────────────────────────────────────────────────────

for (const mode of Object.keys(IFK)) {
    t(`THOR ${mode}: clean`, () => {
        const { text } = decode(oneBlock('thor-decoder', { offsetHz: 1500, mode }), thorTx(MSG, { mode, centre: 1500, idle: 'UBERSDR ' }));
        assert.ok(text.includes(`\n${MSG}`), JSON.stringify(text));
    });
}

t('THOR 16 at −9 dB and THOR 11 at −11 dB, over three noise seeds', () => {
    for (const [mode, snr] of [['16', -9], ['11', -11]]) {
        const sig = thorTx(MSG, { mode, centre: 1500, idle: 'UBERSDR ' });
        let wrong = 0;
        for (const seed of [1, 2, 3]) wrong += errors(decode(oneBlock('thor-decoder', { offsetHz: 1500, mode }), withNoise(sig, snr, seed)).text, MSG);
        assert.ok(wrong <= 2, `THOR ${mode} at ${snr} dB: ${wrong} characters wrong in three`);
    }
});

t('THOR 16 needs no tuning: −120 and +130 Hz off, at −4 dB; and THOR 11 at a 12 kHz stream rate', () => {
    for (const off of [-120, 130]) {
        const sig = withNoise(moved(thorTx(MSG, { mode: '16', centre: 1500, idle: 'UBERSDR ' }), off), -4);
        const { text } = decode(oneBlock('thor-decoder', { offsetHz: 1500, mode: '16' }), sig);
        assert.ok(text.includes(MSG), `${off}: ${JSON.stringify(text)}`);
    }
    const { text } = decode(oneBlock('thor-decoder', { offsetHz: 900, mode: '11' }), withNoise(thorTx(MSG, { mode: '11', centre: 900, rate: 12000, idle: 'UBERSDR ' }), -6));
    assert.ok(text.includes(MSG), JSON.stringify(text));
});

// ── one block, and Expand ───────────────────────────────────────────────────

const ONE_BLOCK = [
    ['olivia-decoder', { tones: 8, bandwidth: 250 }, () => oliviaTx(MSG, { centre: 1500 }), -10],
    ['olivia-decoder', { tones: 4, bandwidth: 125, mode: 'contestia' }, () => oliviaTx(MSG, { tones: 4, bw: 125, centre: 1500, contestia: true }), -10],
    ['mfsk-decoder', { mode: 'mfsk16' }, () => mfskTx(MSG, { centre: 1500 }), -6],
    ['dominoex-decoder', { mode: '16' }, () => dominoTx(MSG, { centre: 1500, idle: 'UBERSDR ' }), -4],
    ['thor-decoder', { mode: '16' }, () => thorTx(MSG, { centre: 1500, idle: 'UBERSDR ' }), -6],
];

for (const [type, params, make, snr] of ONE_BLOCK) {
    t(`${type}${params.mode ? ` (${params.mode})` : ''}: one block, at an offset, and Expand gives the same text`, () => {
        const sig = withNoise(moved(make(), 1000), snr);
        const g = oneBlock(type, { offsetHz: 2500, ...params });
        const one = decode(g, sig).text;
        assert.ok(one.includes(MSG), `${type}: ${JSON.stringify(one)}`);
        const { graph: x, ids } = expandDecoder(g, 'dec');
        assert.ok(ids.length >= 3 && !x.nodes.some((n) => n.id === 'dec'));
        assert.ok(compile(x, 8000).ok, JSON.stringify(compile(x, 8000).errors));
        assert.strictEqual(decode(x, sig).text, one, 'the expanded graph says something else');
    });
}

// ── the blocks on their own ─────────────────────────────────────────────────

/** One block instance, run over `x` (real) in one go: what it put out. */
function runBlock(type, params, x, rate = 1000) {
    const def = BLOCK_BY_TYPE[type];
    const p = sanitizeParams(def, params);
    const inst = def.create();
    inst.configure(p, rate, [rate]);
    const inb = makeBuffer('real', x.length);
    inb.re.set(x);
    const outs = (def.outputsFor ? def.outputsFor(p) : def.outputs).map((o) => makeBuffer(o.kind, def.maxOut ? def.maxOut(x.length, p, rate) : x.length));
    const m = inst.process([inb], outs, x.length);
    return { m, outs };
}

t('MFSK interleaver block: interleaving bits then deinterleaving them gives them back, late', () => {
    const def = BLOCK_BY_TYPE['mfsk-interleaver'];
    assert.strictEqual(def.inputsFor({ kind: 'bits' })[0].kind, 'bits');
    assert.strictEqual(def.outputsFor({ kind: 'soft' })[0].kind, 'real');
    const { u } = rng(4);
    const bits = Float64Array.from({ length: 4000 }, () => (u() < 0.5 ? 1 : 0));
    const a = runBlock('mfsk-interleaver', { direction: 'interleave', kind: 'bits' }, bits);
    const b = runBlock('mfsk-interleaver', { direction: 'deinterleave', kind: 'bits' }, a.outs[0].re.subarray(0, a.m));
    const out = b.outs[0].re;
    // fldigi's pair, size 4 and depth 10, delays every bit by the same amount.
    let lag = -1;
    for (let L = 0; L < 1000 && lag < 0; L++) if (bits.subarray(0, 2000).every((v, i) => out[i + L] === v)) lag = L;
    assert.ok(lag > 0, 'never lines up');
});

t('Soft Viterbi block: soft pairs from the K = 7 encoder decode, even with a third of them wiped out', () => {
    const enc = encoderK7();
    const { u } = rng(8);
    const bits = Array.from({ length: 1000 }, () => (u() < 0.5 ? 1 : 0));
    const soft = [];
    for (const b of [...bits, ...new Array(120).fill(0)]) {
        const pair = enc(b);
        for (const v of [pair & 1, (pair >> 1) & 1]) soft.push(u() < 0.33 ? 0 : (v ? 0.8 : -0.8));
    }
    const { m, outs } = runBlock('soft-viterbi', { code: 'nasa' }, Float64Array.from(soft));
    assert.ok(m >= 1000);
    assert.deepStrictEqual(Array.from(outs[0].re.subarray(0, 1000)), bits);
});


console.log(`${pass} passed`);
