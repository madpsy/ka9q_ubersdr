// The MFSK family — Olivia, Contestia, MFSK16 and MFSK32, DominoEX, THOR — as
// the stages they are built from, so the same parts make all of them:
//
//   MFSK16    tone detector → demapper → deinterleaver → Viterbi (soft) → MFSK Varicode
//   THOR      tone detector → IFK+ decoder → deinterleaver → Viterbi (soft) → MFSK Varicode
//   DominoEX  tone detector → IFK+ decoder → DominoEX Varicode
//   Olivia    tone detector → Olivia FEC
//
// Every one follows fldigi (~/repos/fldigi/src) where it matters on the air —
// tone order, Gray code, interleaver, code, character tables, bit order — so
// it reads what fldigi sends; how it finds the tones is its own (see
// mfsk/tones.js).
//
// Two streams pass between the stages that the rest of the playground does
// not have, both carried as real numbers:
//
//   tone frames   from the detector: for each symbol (two for Olivia), the
//                 power at each point of its row — the tones, and whatever it
//                 was set to look at between and beyond them. A frame is as
//                 many numbers as the row has points, so the stream's rate is
//                 the frame rate times that, and the stage after needs the
//                 same tones, oversampling and margin to know where each tone
//                 is. They always arrive whole.
//   soft bits     a confidence per bit: +1 a sure 1, −1 a sure 0, 0 no idea —
//                 what the soft Viterbi decoder (blocks/fec.js) takes, as
//                 fldigi's decoder takes 0–255. A symbol's bits come together,
//                 the most significant first, as fldigi sends them.

import { BITS, COMPLEX, MESSAGE, REAL } from '../block.js';
import { ToneDetector, framesPerSymbol, toneGrid } from '../mfsk/tones.js';
import { Interleaver } from '../mfsk/interleave.js';
import { DominoVaricode, MfskVaricode, printable } from '../mfsk/varicode.js';
import { OliviaReceiver } from '../mfsk/olivia.js';

const TONES = { kind: 'number', label: 'Tones', default: 16, min: 2, max: 256, step: 1, control: false };
const OVERSAMPLE = { kind: 'number', label: 'Points per tone', default: 1, min: 1, max: 8, step: 1, control: false };
const MARGIN = { kind: 'number', label: 'Margin', unit: 'tones', default: 0, min: 0, max: 32, step: 0.5, control: false };

/** A row's settings from a block's, for toneGrid. */
const rowOf = (p) => ({ tones: p.tones, oversample: p.oversample, margin: p.margin });

/** Reads whole frames of `size` out of a stream that may hand them over in pieces. */
class Frames {
    constructor() { this.buf = new Float64Array(0); this.have = 0; }

    reset() { this.have = 0; }

    /** Calls `each(frame)` for every frame completed by `n` values of `x`. */
    take(x, n, size, each) {
        if (this.buf.length !== size) { this.buf = new Float64Array(size); this.have = 0; }
        let i = 0;
        // Whole frames straight from the input; only a frame split across
        // packets is copied.
        if (this.have) {
            while (i < n && this.have < size) this.buf[this.have++] = x[i++];
            if (this.have < size) return;
            each(this.buf, 0);
            this.have = 0;
        }
        for (; i + size <= n; i += size) each(x, i);
        while (i < n) this.buf[this.have++] = x[i++];
    }
}

// ── the tone detector ───────────────────────────────────────────────────────

const PULSES = [
    { value: 'rect', label: 'One per symbol, found (MFSK16, DominoEX, THOR)' },
    { value: 'olivia', label: 'Two per symbol, raised cosine (Olivia, Contestia)' },
];

export const MfskDetectorBlock = {
    type: 'mfsk-detector',
    label: 'MFSK tone detector',
    category: 'Digital',
    summary: 'Many-tone FSK to tone frames: the power at each tone (and between, and beyond) once a symbol. Centre it on zero first.',
    inputs: [{ name: 'in', kind: COMPLEX }],
    outputs: [{ name: 'tones', kind: REAL, audio: false }],
    params: {
        tones: TONES,
        spacingHz: { kind: 'number', label: 'Tone spacing', unit: 'Hz', default: 15.625, min: 0.1, max: 1000, step: 0.001, control: false },
        baud: { kind: 'number', label: 'Baud', default: 15.625, min: 0.1, max: 1000, step: 0.001, control: false },
        oversample: OVERSAMPLE,
        margin: MARGIN,
        pulse: { kind: 'choice', label: 'Frames', default: 'rect', options: PULSES },
        afc: { kind: 'bool', label: 'AFC', default: true },
        afcRangeHz: { kind: 'number', label: 'AFC range', unit: 'Hz', default: 15, min: 1, max: 200, step: 1, control: false, showIf: (p) => p.afc },
        invert: { kind: 'bool', label: 'Invert (tones high to low)', default: false },
    },
    rate: (inRate, p) => p.baud * framesPerSymbol(p.pulse) * toneGrid(rowOf(p)).size,
    // The frames come a symbol apart, give or take the timing's quarter.
    maxOut: (n, p, inRate) => (Math.ceil((n * p.baud * framesPerSymbol(p.pulse)) / (0.75 * Math.max(1, inRate || 1))) + 3) * toneGrid(rowOf(p)).size,
    create() {
        const det = new ToneDetector();
        let inRate = 12000;
        let frames = 0;
        let size = 1;
        return {
            configure(p, r) {
                inRate = r;
                size = toneGrid(rowOf(p)).size;
                det.configure(r, { ...p, afc: p.afc && p.pulse === 'rect' });
            },
            reset() { det.reset(); frames = 0; },
            read() { return { afcHz: det.afcHz, frames }; },
            process(ins, outs, n) {
                const m = det.process(ins[0].re, ins[0].im, n, inRate, outs[0].re, 0);
                frames += m / size;
                return m;
            },
        };
    },
};

// ── MFSK16: tones to soft bits ──────────────────────────────────────────────

/** fldigi's graydecode (misc.cxx) — which, despite the name, is the Gray code: tone i carries data i ^ (i >> 1). */
const mfskGray = (i) => i ^ (i >> 1);

/**
 * Tone frames to soft bits, as mfsk::softdecode: each tone's magnitude votes
 * for the bits of the data it stands for — +1 where the bit is 1, −1 where it
 * is 0 — and each bit's vote, against the sum of all the magnitudes, is how
 * sure it is. fldigi's MFSK transmitter sends data d on tone grayencode(d),
 * the inverse Gray code, so tone i stands for the Gray code of i.
 */
export const MfskDemapperBlock = {
    type: 'mfsk-demapper',
    label: 'MFSK demapper',
    category: 'Digital',
    summary: 'Tone frames to soft bits — MFSK16’s and MFSK32’s, with fldigi’s Gray code — for a deinterleaver and a soft Viterbi decoder.',
    inputs: [{ name: 'tones', kind: REAL, audio: false }],
    outputs: [{ name: 'soft', kind: REAL, audio: false }],
    params: {
        tones: TONES,
        oversample: OVERSAMPLE,
        margin: MARGIN,
        gray: { kind: 'bool', label: 'Gray code (fldigi MFSK)', default: true },
    },
    rate: (inRate, p) => (inRate / toneGrid(rowOf(p)).size) * Math.floor(Math.log2(p.tones)),
    maxOut: (n, p) => (Math.ceil(n / toneGrid(rowOf(p)).size) + 1) * Math.floor(Math.log2(p.tones)),
    create() {
        const frames = new Frames();
        let p = {};
        let grid = null;
        let bits = 4;
        let mag = new Float64Array(16);
        const b = new Float64Array(8);
        return {
            configure(params) {
                p = params;
                grid = toneGrid(rowOf(p));
                bits = Math.floor(Math.log2(p.tones));
                if (mag.length !== p.tones) mag = new Float64Array(p.tones);
            },
            reset() { frames.reset(); },
            process(ins, outs, n) {
                const out = outs[0].re;
                const M = 1 << bits;
                let m = 0;
                frames.take(ins[0].re, n, grid.size, (f, at) => {
                    let sum = 0;
                    for (let i = 0; i < M; i++) {
                        mag[i] = Math.sqrt(Math.max(0, f[at + grid.first + i * grid.os]));
                        sum += mag[i];
                    }
                    b.fill(0);
                    for (let i = 0; i < M; i++) {
                        const j = p.gray ? mfskGray(i) : i;
                        for (let k = 0; k < bits; k++) b[k] += (j & (1 << (bits - k - 1))) ? mag[i] : -mag[i];
                    }
                    // fldigi: 128 + b / sum × 256, clamped to a byte — which is
                    // ±1 here at 2b / sum.
                    for (let k = 0; k < bits; k++) out[m++] = sum > 1e-30 ? Math.max(-1, Math.min(1, (2 * b[k]) / sum)) : 0;
                });
                return m;
            },
        };
    },
};

// ── DominoEX and THOR: incremental frequency keying ─────────────────────────

/**
 * IFK+: the data is not which tone but how far the tone moved. fldigi's
 * dominoex::sendsymbol and thor::sendsymbol send symbol s as the tone
 * (last + 2 + s) mod 18 — always moving, at least two tones up or wrapped
 * round — so a receiver mistuned by any amount still reads the same steps,
 * and no tone repeats for a carrier to hide in.
 *
 * Hard: the step between the strongest point of this frame and of the last,
 * in tones, less 2, wrapped (dominoex::decodesymbol) — fine points between
 * the tones (fldigi's `paths`) are what let a mistuned signal still land on a
 * whole number of tones' difference. Soft: from where the last tone was, the
 * magnitude at each place the next could be — s + 2 tones up, or the same
 * wrapped down — votes for the bits of s, as the MFSK demapper does; a frame
 * with nothing standing out (fldigi's staticburst, max < 1.2 × average) gives
 * no opinion at all. The bits of s go out most significant first, as THOR's
 * decodesymbol hands them on.
 */
export const IfkDecoderBlock = {
    type: 'ifk-decoder',
    label: 'IFK+ decoder',
    category: 'Digital',
    summary: 'DominoEX’s and THOR’s incremental keying: the step from one tone to the next is the data. Tone frames in, soft bits (four a symbol) out.',
    inputs: [{ name: 'tones', kind: REAL, audio: false }],
    outputs: [{ name: 'soft', kind: REAL, audio: false }],
    params: {
        tones: { ...TONES, default: 18 },
        oversample: { ...OVERSAMPLE, default: 5 },
        margin: { ...MARGIN, default: 9 },
        soft: { kind: 'bool', label: 'Soft decisions', default: true },
    },
    rate: (inRate, p) => (inRate / toneGrid(rowOf(p)).size) * Math.floor(Math.log2(p.tones - 2)),
    maxOut: (n, p) => (Math.ceil(n / toneGrid(rowOf(p)).size) + 1) * Math.floor(Math.log2(p.tones - 2)),
    create() {
        const frames = new Frames();
        let p = {};
        let grid = null;
        let bits = 4;
        let prev = -1;
        let mag = new Float64Array(16);
        const b = new Float64Array(8);
        return {
            configure(params) {
                p = params;
                grid = toneGrid(rowOf(p));
                bits = Math.floor(Math.log2(p.tones - 2));
                if (mag.length !== 1 << bits) mag = new Float64Array(1 << bits);
            },
            reset() { frames.reset(); prev = -1; },
            process(ins, outs, n) {
                const out = outs[0].re;
                const { os, size } = grid;
                const T = Math.round(p.tones);
                const S = 1 << bits;
                let m = 0;
                frames.take(ins[0].re, n, size, (f, at) => {
                    let cur = 0;
                    let avg = 0;
                    for (let g = 0; g < size; g++) {
                        avg += Math.sqrt(Math.max(0, f[at + g]));
                        if (f[at + g] > f[at + cur]) cur = g;
                    }
                    avg /= size;
                    const last = prev;
                    const quiet = Math.sqrt(Math.max(0, f[at + cur])) < 1.2 * avg;
                    // Nothing standing out is no reference for the next step either.
                    prev = quiet ? -1 : cur;
                    if (last < 0 || quiet) {
                        for (let k = 0; k < bits; k++) out[m++] = 0;
                        return;
                    }
                    if (!p.soft) {
                        const diff = (cur - last) / os;
                        let c = Math.round(diff) - 2;
                        if (c < 0) c += T;
                        const ok = Math.abs(diff) <= T - 1 && c >= 0 && c < S;
                        for (let k = bits - 1; k >= 0; k--) out[m++] = ok ? ((c >> k) & 1 ? 1 : -1) : 0;
                        return;
                    }
                    let sum = 0;
                    for (let s = 0; s < S; s++) {
                        const up = last + (s + 2) * os;
                        const down = last + (s + 2 - T) * os;
                        let pw = 0;
                        if (up < size) pw = f[at + up];
                        if (down >= 0 && f[at + down] > pw) pw = f[at + down];
                        mag[s] = Math.sqrt(Math.max(0, pw));
                        sum += mag[s];
                    }
                    b.fill(0);
                    for (let s = 0; s < S; s++) {
                        for (let k = 0; k < bits; k++) b[k] += (s & (1 << (bits - k - 1))) ? mag[s] : -mag[s];
                    }
                    for (let k = 0; k < bits; k++) out[m++] = sum > 1e-30 ? Math.max(-1, Math.min(1, (2 * b[k]) / sum)) : 0;
                });
                return m;
            },
        };
    },
};

// ── the interleaver ─────────────────────────────────────────────────────────

const INTERLEAVE_KINDS = [
    { value: 'soft', label: 'Soft bits (receiving)' },
    { value: 'bits', label: 'Bits (sending)' },
];
const portsOf = (p) => [{ name: 'in', kind: p.kind === 'bits' ? BITS : REAL, audio: false }];

/**
 * fldigi's MFSK interleaver (mfsk/interleave.js): `size` bits a symbol spread
 * over size × depth symbols — 4 and 10 for MFSK16, MFSK32 and THOR. Interleave
 * going out, deinterleave coming in.
 */
export const MfskInterleaverBlock = {
    type: 'mfsk-interleaver',
    label: 'MFSK interleaver',
    category: 'Digital',
    summary: 'fldigi’s diagonal interleaver — MFSK16’s, MFSK32’s, THOR’s: spreads a burst of errors thin for the Viterbi decoder. Interleaves or deinterleaves.',
    inputs: [{ name: 'in', kind: REAL, audio: false }],
    outputs: [{ name: 'out', kind: REAL, audio: false }],
    inputsFor: portsOf,
    outputsFor: (p) => [{ name: 'out', kind: p.kind === 'bits' ? BITS : REAL, audio: false }],
    params: {
        direction: { kind: 'choice', label: 'Direction', default: 'deinterleave', options: [{ value: 'deinterleave', label: 'Deinterleave' }, { value: 'interleave', label: 'Interleave' }] },
        kind: { kind: 'choice', label: 'Carries', default: 'soft', options: INTERLEAVE_KINDS },
        size: { kind: 'number', label: 'Bits per symbol', default: 4, min: 1, max: 8, step: 1, control: false },
        depth: { kind: 'number', label: 'Depth', default: 10, min: 1, max: 200, step: 1, control: false },
    },
    maxOut: (n, p) => n + p.size,
    create() {
        let il = null;
        let key = '';
        let held = null;
        let have = 0;
        return {
            configure(p) {
                const k = `${p.size}/${p.depth}/${p.direction}`;
                if (k === key) return;
                key = k;
                il = new Interleaver(p.size, p.depth, p.direction === 'interleave');
                held = new Float64Array(p.size);
                have = 0;
            },
            reset() { if (il) il.flush(); have = 0; },
            latency() { return il ? il.size * il.size * il.depth : 0; },
            process(ins, outs, n) {
                const x = ins[0].re;
                const out = outs[0].re;
                const size = il.size;
                let m = 0;
                for (let i = 0; i < n; i++) {
                    held[have++] = x[i];
                    if (have < size) continue;
                    il.symbols(held);
                    out.set(held, m);
                    m += size;
                    have = 0;
                }
                return m;
            },
        };
    },
};

// ── the character codes ─────────────────────────────────────────────────────

/** Characters to text messages on two ports, primary and THOR's or DominoEX's second line. */
function textOut(outs, primary, secondary) {
    if (primary) outs[0].list.push({ type: 'text', text: primary });
    if (secondary && outs[1]) outs[1].list.push({ type: 'text', text: secondary });
}

/**
 * MFSK's Varicode (and THOR's, which adds a second alphabet for the text
 * THOR sends while its operator is not typing) from decoded bits to text.
 */
export const MfskVaricodeBlock = {
    type: 'mfsk-varicode',
    label: 'MFSK Varicode decoder',
    category: 'Digital',
    summary: 'MFSK16’s and THOR’s character code: bits to text. THOR’s idle text comes out on its own port.',
    inputs: [{ name: 'bits', kind: BITS }],
    outputs: [{ name: 'text', kind: MESSAGE }, { name: 'secondary', kind: MESSAGE }],
    params: {
        secondary: { kind: 'bool', label: 'THOR’s second alphabet', default: false },
    },
    create() {
        const dec = new MfskVaricode();
        const state = { cr: false };
        return {
            configure(p) { dec.secondary = p.secondary; },
            reset() { dec.reset(); state.cr = false; },
            process(ins, outs, n) {
                const b = ins[0].re;
                let text = '';
                let sec = '';
                for (let k = 0; k < n; k++) {
                    const c = dec.push(b[k]);
                    if (c < 0) continue;
                    if (c & 0x100) sec += String.fromCharCode(c & 0xff);
                    else text += printable(c, state);
                }
                textOut(outs, text, sec);
                return 0;
            },
        };
    },
};

/**
 * DominoEX's nibble code, from the IFK+ decoder's bits — four a symbol, most
 * significant first, read hard — to text. The second alphabet is what
 * DominoEX sends while its operator is not typing; it comes out on its own
 * port.
 */
export const DominoVaricodeBlock = {
    type: 'dominoex-varicode',
    label: 'DominoEX Varicode decoder',
    category: 'Digital',
    summary: 'DominoEX’s character code: one nibble a symbol to text. The idle text comes out on its own port.',
    inputs: [{ name: 'soft', kind: REAL, audio: false }],
    outputs: [{ name: 'text', kind: MESSAGE }, { name: 'secondary', kind: MESSAGE }],
    params: {},
    create() {
        const dec = new DominoVaricode();
        const state = { cr: false };
        let nib = 0;
        let have = 0;
        let sure = false;
        return {
            configure() {},
            reset() { dec.reset(); state.cr = false; nib = 0; have = 0; sure = false; },
            process(ins, outs, n) {
                const x = ins[0].re;
                let text = '';
                let sec = '';
                for (let k = 0; k < n; k++) {
                    nib = (nib << 1) | (x[k] > 0 ? 1 : 0);
                    if (x[k] !== 0) sure = true;
                    if (++have < 4) continue;
                    // A symbol with no opinion at all (the IFK+ decoder's for
                    // a frame with no tone in it) loses the character it was
                    // part of, as fldigi's staticburst does, rather than
                    // reading as nibble 0 — a space.
                    const c = sure ? dec.push(nib & 15) : (dec.reset(), -1);
                    nib = 0;
                    have = 0;
                    sure = false;
                    if (c < 0) continue;
                    if (c & 0x100) {
                        const s = c & 0xff;
                        if (s >= 32 && s !== 127) sec += String.fromCharCode(s);
                    } else {
                        text += printable(c, state);
                    }
                }
                textOut(outs, text, sec);
                return 0;
            },
        };
    },
};

// ── Olivia and Contestia ────────────────────────────────────────────────────

const OLIVIA_TONES = [2, 4, 8, 16, 32, 64, 128, 256];

/**
 * Olivia's (or Contestia's) error correction and synchronisation, from a tone
 * detector set to Olivia's frames: two a symbol, two points a tone, and the
 * same margin as here. See mfsk/olivia.js for the code, and why the search,
 * the soft decisions and the decode are one stage rather than three.
 *
 * Characters as olivia::rx_process prints them: 127 escapes the next one into
 * the top half of Latin-1 (fldigi's "8-bit extended characters", on by
 * default), and nothing under 8 — the idle NULs among them — is printed.
 */
export const OliviaFecBlock = {
    type: 'olivia-fec',
    label: 'Olivia FEC',
    category: 'Digital',
    summary: 'Olivia’s and Contestia’s Walsh–Hadamard code and its search for the signal: tone frames in (two a symbol, two points a tone), text out.',
    inputs: [{ name: 'tones', kind: REAL, audio: false }],
    outputs: [{ name: 'text', kind: MESSAGE }],
    params: {
        mode: { kind: 'choice', label: 'Mode', default: 'olivia', options: [{ value: 'olivia', label: 'Olivia' }, { value: 'contestia', label: 'Contestia' }] },
        tones: { kind: 'choice', label: 'Tones', default: 8, options: OLIVIA_TONES.map((v) => ({ value: v, label: String(v) })) },
        // ±4 tones: fldigi's tune margin of 8 half-tone steps. One at least,
        // as MFSK_Receiver::Preset insists.
        margin: { ...MARGIN, default: 4, label: 'Search margin', min: 1, max: 16 },
        integration: { kind: 'number', label: 'Integration', unit: 'blocks', default: 4, min: 2, max: 32, step: 1, control: false },
        // The reference's floor is 3, which in plain noise lets a character
        // or so a second through; 3.5 let none through in two minutes of it,
        // for a fraction of a dB at the weakest (test/playgroundmfsk.test.js).
        threshold: { kind: 'number', label: 'Squelch (S/N)', default: 3.5, min: 0, max: 20, step: 0.1, live: true },
        eightBit: { kind: 'bool', label: '8-bit characters', default: true },
    },
    create() {
        const frames = new Frames();
        let rx = null;
        let key = '';
        let p = {};
        let spacing = 0;
        let escape = false;
        let chars = 0;
        const state = { cr: false };
        return {
            configure(params, r) {
                p = params;
                const margin = Math.round(p.margin * 2);
                const k = `${p.mode}/${p.tones}/${margin}/${p.integration}`;
                if (k !== key) {
                    key = k;
                    rx = new OliviaReceiver({ tones: p.tones, margin, contestia: p.mode === 'contestia', integration: p.integration, threshold: p.threshold });
                    frames.reset();
                    escape = false;
                }
                rx.threshold = p.threshold;
                // Two frames a symbol, and an Olivia symbol's rate is its tone
                // spacing: the spacing, from the rate the frames come at.
                spacing = r / (2 * rx.width);
            },
            reset() { if (rx) rx.reset(); frames.reset(); escape = false; state.cr = false; chars = 0; },
            read() { return rx ? { snr: rx.snr, offsetHz: (rx.offsetSteps * spacing) / 2, chars } : null; },
            process(ins, outs, n) {
                let text = '';
                frames.take(ins[0].re, n, rx.width, (f, at) => {
                    const block = rx.frame(f, at);
                    if (!block) return;
                    for (let c of block) {
                        // olivia::unescape.
                        if (p.eightBit && p.mode === 'olivia') {
                            if (escape) { escape = false; c += 128; } else if (c === 127) { escape = true; continue; }
                        }
                        if (c <= 7) continue;
                        const s = printable(c, state);
                        text += s;
                        chars += s.length;
                    }
                });
                if (text) outs[0].list.push({ type: 'text', text });
                return 0;
            },
        };
    },
};
