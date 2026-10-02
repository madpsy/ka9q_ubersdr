// Bits and bytes: what a protocol is assembled from once a slicer has made the
// bits — GNU Radio's pack/unpack_k_bits, correlate_access_code and crc check,
// and a way to read the result.
//
//   Pack bits        bits to bytes (k bits a byte, either order)
//   Unpack bits      bytes back to bits
//   Sync word        a frame found by its sync word (allowing so many wrong
//                    bits), and the bits after it, as one message
//   CRC check        a frame's CRC checked — the common ones by name, or any —
//                    good frames on one output, bad on the other
//   Bytes to text    bytes or a frame as hex, text, or binary, for a console
//
// Bytes and frames travel as messages: { type: 'bytes', bytes: [...] } and
// { type: 'frame', bits: [...], bytes: [...], errors, at }.

import { BITS, CONTROL, MESSAGE, emitControl } from '../block.js';

const ORDER = { kind: 'choice', label: 'Bit order', default: 'msb', options: [{ value: 'msb', label: 'Most significant first' }, { value: 'lsb', label: 'Least significant first' }] };

/** Bits to bytes of `k` bits, most or least significant first; a remainder is dropped. */
export function packBits(bits, k = 8, msb = true) {
    const out = [];
    for (let i = 0; i + k <= bits.length; i += k) {
        let v = 0;
        for (let j = 0; j < k; j++) {
            const b = bits[i + j] ? 1 : 0;
            v |= msb ? b << (k - 1 - j) : b << j;
        }
        out.push(v >>> 0);
    }
    return out;
}

/** Bytes to bits, `k` bits each. */
export function unpackBits(bytes, k = 8, msb = true) {
    const out = [];
    for (const v of bytes) for (let j = 0; j < k; j++) out.push((v >>> (msb ? k - 1 - j : j)) & 1);
    return out;
}

/** A message's bytes, whatever kind of message carries them: bytes, a frame, or text. */
export function bytesOf(m) {
    if (!m) return null;
    if (Array.isArray(m.bytes)) return m.bytes;
    if (m.type === 'frame' && Array.isArray(m.bits)) return packBits(m.bits);
    if (m.type === 'text' && typeof m.text === 'string') return Array.from(new TextEncoder().encode(m.text));
    return null;
}

export const PackBitsBlock = {
    type: 'pack-bits',
    label: 'Pack bits',
    category: 'Digital',
    summary: 'Bits to bytes — k bits a byte, either order — as messages.',
    inputs: [{ name: 'bits', kind: BITS }],
    outputs: [{ name: 'bytes', kind: MESSAGE }],
    params: { k: { kind: 'number', label: 'Bits a byte', default: 8, min: 1, max: 32, step: 1, control: false }, order: ORDER },
    create() {
        let p = {};
        let held = [];
        return {
            configure(params) { p = params; },
            reset() { held = []; },
            process(ins, outs, n) {
                const x = ins[0];
                const m = x && x.n != null ? x.n : n;
                for (let k = 0; k < m; k++) held.push(x.re[k] ? 1 : 0);
                const k = Math.max(1, Math.round(p.k));
                const whole = held.length - (held.length % k);
                if (whole && outs[0] && outs[0].list) outs[0].list.push({ type: 'bytes', bytes: packBits(held.slice(0, whole), k, p.order !== 'lsb') });
                held = held.slice(whole);
                return 0;
            },
        };
    },
};

export const UnpackBitsBlock = {
    type: 'unpack-bits',
    label: 'Unpack bits',
    category: 'Digital',
    summary: 'Bytes (or a frame, or text) back to bits, k a byte, either order.',
    inputs: [{ name: 'bytes', kind: MESSAGE }],
    outputs: [{ name: 'bits', kind: BITS }],
    rate: () => 1,
    maxOut: () => 65536,
    params: { k: { kind: 'number', label: 'Bits a byte', default: 8, min: 1, max: 32, step: 1, control: false }, order: ORDER },
    create() {
        let p = {};
        return {
            configure(params) { p = params; },
            reset() {},
            process(ins, outs) {
                const out = outs[0] && outs[0].re;
                let m = 0;
                for (const msg of (ins[0] && ins[0].list) || []) {
                    const bytes = bytesOf(msg);
                    if (!bytes) continue;
                    for (const b of unpackBits(bytes, Math.max(1, Math.round(p.k)), p.order !== 'lsb')) {
                        if (out && m < out.length) out[m++] = b;
                    }
                }
                return m;
            },
        };
    },
};

/** A sync word from its text: binary digits, or hex after 0x. Null if neither. */
export function parseSyncWord(text) {
    const s = String(text || '').replace(/[\s_]/g, '');
    if (/^0x[0-9a-f]+$/i.test(s)) return unpackBits(Array.from(s.slice(2), (c) => parseInt(c, 16)), 4);
    if (/^[01]+$/.test(s)) return Array.from(s, Number);
    return null;
}

/**
 * A frame found by its sync word (gr-digital correlate_access_code): the bits
 * are watched through a window as long as the word, and where they match it
 * with no more than `maxErrors` wrong, the next `frameBits` are a frame.
 */
export const SyncFramerBlock = {
    type: 'sync-framer',
    label: 'Sync word framer',
    category: 'Digital',
    summary: 'Finds a sync word in a bit stream — allowing a few wrong bits — and passes the frame after it as one message.',
    inputs: [{ name: 'bits', kind: BITS }],
    outputs: [{ name: 'frames', kind: MESSAGE }, { name: 'found', kind: CONTROL }],
    params: {
        word: { kind: 'text', label: 'Sync word (binary, or 0x hex)', default: '0x1ACFFC1D', max: 256 },
        maxErrors: { kind: 'number', label: 'Wrong bits allowed', default: 2, min: 0, max: 32, step: 1, live: true },
        frameBits: { kind: 'number', label: 'Frame length', unit: 'bits', default: 256, min: 1, max: 65536, step: 1, control: false },
        invert: { kind: 'bool', label: 'Also find it inverted', default: false, live: true },
    },
    create() {
        let p = {};
        let word = [];
        let win = [];
        let frame = null;
        let found = 0;
        let count = 0;
        return {
            configure(params) { p = params; word = parseSyncWord(params.word) || []; win = []; },
            reset() { win = []; frame = null; found = 0; count = 0; },
            read() { return { found, word: word.length }; },
            process(ins, outs, n) {
                const x = ins[0];
                const m = x && x.n != null ? x.n : n;
                const L = word.length;
                for (let k = 0; k < m; k++) {
                    const b = x.re[k] ? 1 : 0;
                    count++;
                    if (frame) {
                        frame.bits.push(frame.inverted ? 1 - b : b);
                        if (frame.bits.length >= p.frameBits) {
                            if (outs[0] && outs[0].list) outs[0].list.push({ type: 'frame', bits: frame.bits, bytes: packBits(frame.bits), errors: frame.errors, inverted: frame.inverted, at: frame.at });
                            frame = null;
                        }
                        continue;
                    }
                    if (!L) continue;
                    win.push(b);
                    if (win.length > L) win.shift();
                    if (win.length < L) continue;
                    let e = 0;
                    for (let i = 0; i < L; i++) if (win[i] !== word[i]) e++;
                    const inv = p.invert && L - e <= p.maxErrors;
                    if (e <= p.maxErrors || inv) {
                        found++;
                        frame = { bits: [], errors: inv && e > p.maxErrors ? L - e : e, inverted: inv && e > p.maxErrors, at: count };
                        win = [];
                        if (outs[1]) emitControl(outs[1], found);
                    }
                }
                return 0;
            },
        };
    },
};

/** CRCs by name: width, polynomial, initial value, reflections, final XOR (the Rocksoft model). */
export const CRCS = {
    'crc8': { label: 'CRC-8', width: 8, poly: 0x07, init: 0, refIn: false, refOut: false, xorOut: 0 },
    'crc16-ccitt': { label: 'CRC-16/CCITT-FALSE', width: 16, poly: 0x1021, init: 0xffff, refIn: false, refOut: false, xorOut: 0 },
    'crc16-xmodem': { label: 'CRC-16/XMODEM', width: 16, poly: 0x1021, init: 0, refIn: false, refOut: false, xorOut: 0 },
    'crc16-x25': { label: 'CRC-16/X-25 (HDLC, AX.25)', width: 16, poly: 0x1021, init: 0xffff, refIn: true, refOut: true, xorOut: 0xffff },
    'crc16-arc': { label: 'CRC-16/ARC', width: 16, poly: 0x8005, init: 0, refIn: true, refOut: true, xorOut: 0 },
    'crc32': { label: 'CRC-32', width: 32, poly: 0x04c11db7, init: 0xffffffff, refIn: true, refOut: true, xorOut: 0xffffffff },
};

const reflect = (v, w) => { let r = 0; for (let i = 0; i < w; i++) if (v & (2 ** i)) r += 2 ** (w - 1 - i); return r; };

/** The CRC of `bits` under `c`, bit at a time (so any width up to 32, any frame length). */
export function crcBits(bits, c) {
    const top = 2 ** (c.width - 1);
    const mask = 2 ** c.width;
    let reg = c.init;
    // Reflected input is a byte at a time reversed; a bit stream not a whole
    // number of bytes is taken as it comes.
    const seq = c.refIn ? [] : bits;
    if (c.refIn) for (let i = 0; i < bits.length; i += 8) seq.push(...bits.slice(i, i + 8).reverse());
    for (const b of seq) {
        const fb = ((reg >= top ? 1 : 0) ^ (b ? 1 : 0));
        reg = (reg * 2) % mask;
        if (fb) reg = ((reg ^ c.poly) >>> 0) % mask;
    }
    if (c.refOut) reg = reflect(reg, c.width);
    return ((reg ^ c.xorOut) >>> 0) % mask;
}

export const CrcCheckBlock = {
    type: 'crc-check',
    label: 'CRC check',
    category: 'Digital',
    summary: 'Checks the CRC on the end of each frame — the common ones by name, or any — good frames out one side, bad the other.',
    inputs: [{ name: 'frames', kind: MESSAGE }],
    outputs: [{ name: 'good', kind: MESSAGE }, { name: 'bad', kind: MESSAGE }, { name: 'rate', kind: CONTROL }],
    params: {
        crc: { kind: 'choice', label: 'CRC', default: 'crc16-ccitt', options: [...Object.entries(CRCS).map(([value, c]) => ({ value, label: c.label })), { value: 'custom', label: 'Your own' }] },
        width: { kind: 'number', label: 'Width', unit: 'bits', default: 16, min: 1, max: 32, step: 1, control: false, showIf: (p) => p.crc === 'custom' },
        poly: { kind: 'text', label: 'Polynomial (hex)', default: '1021', max: 8, showIf: (p) => p.crc === 'custom' },
        init: { kind: 'text', label: 'Initial value (hex)', default: 'FFFF', max: 8, showIf: (p) => p.crc === 'custom' },
        xorOut: { kind: 'text', label: 'Final XOR (hex)', default: '0', max: 8, showIf: (p) => p.crc === 'custom' },
        reflect: { kind: 'bool', label: 'Reflected', default: false, showIf: (p) => p.crc === 'custom' },
        strip: { kind: 'bool', label: 'Take the CRC off good frames', default: true, live: true },
    },
    create() {
        let p = {};
        let good = 0;
        let bad = 0;
        const spec = () => {
            if (p.crc !== 'custom') return CRCS[p.crc] || CRCS['crc16-ccitt'];
            const hex = (s) => (parseInt(String(s || '0'), 16) >>> 0) || 0;
            const w = Math.max(1, Math.min(32, Math.round(p.width)));
            const m = 2 ** w;
            return { width: w, poly: hex(p.poly) % m, init: hex(p.init) % m, xorOut: hex(p.xorOut) % m, refIn: !!p.reflect, refOut: !!p.reflect };
        };
        return {
            configure(params) { p = params; },
            reset() { good = 0; bad = 0; },
            read() { return { good, bad }; },
            process(ins, outs) {
                const c = spec();
                let changed = false;
                for (const msg of (ins[0] && ins[0].list) || []) {
                    const bits = msg && msg.type === 'frame' && Array.isArray(msg.bits) ? msg.bits : (bytesOf(msg) ? unpackBits(bytesOf(msg)) : null);
                    if (!bits || bits.length <= c.width) continue;
                    const body = bits.slice(0, bits.length - c.width);
                    const tail = bits.slice(bits.length - c.width);
                    let sent = 0;
                    // Sent most significant first; a reflected CRC goes out a byte
                    // at a time least significant first, as HDLC sends it.
                    if (c.refOut && c.width % 8 === 0) {
                        const bytes = packBits(tail, 8, false);
                        for (let i = 0; i < bytes.length; i++) sent += bytes[i] * 2 ** (8 * i);
                    } else {
                        for (const b of tail) sent = sent * 2 + b;
                    }
                    const ok = crcBits(body, c) === sent;
                    changed = true;
                    if (ok) good++; else bad++;
                    const out = ok ? outs[0] : outs[1];
                    const keep = ok && p.strip ? body : bits;
                    if (out && out.list) out.list.push({ ...msg, type: 'frame', bits: keep, bytes: packBits(keep), crcOk: ok });
                }
                if (changed && outs[2]) emitControl(outs[2], good + bad ? good / (good + bad) : 0);
                return 0;
            },
        };
    },
};

/** Bytes as text: hex, the characters themselves, binary, or hex beside the characters. */
export function bytesText(bytes, format) {
    switch (format) {
        case 'ascii': return bytes.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : b === 10 ? '\n' : '.')).join('');
        case 'binary': return bytes.map((b) => b.toString(2).padStart(8, '0')).join(' ');
        case 'dump': {
            const rows = [];
            for (let i = 0; i < bytes.length; i += 16) {
                const row = bytes.slice(i, i + 16);
                rows.push(`${i.toString(16).padStart(4, '0')}  ${row.map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47)}  ${row.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')}`);
            }
            return rows.join('\n');
        }
        default: return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    }
}

export const BytesTextBlock = {
    type: 'bytes-text',
    label: 'Bytes to text',
    category: 'Digital',
    summary: 'Bytes or a frame as hex, as text, as binary, or as a hex dump — for a console or a log.',
    inputs: [{ name: 'in', kind: MESSAGE }],
    outputs: [{ name: 'text', kind: MESSAGE }],
    params: {
        format: {
            kind: 'choice', label: 'As', default: 'hex',
            options: [{ value: 'hex', label: 'Hex' }, { value: 'ascii', label: 'Text' }, { value: 'binary', label: 'Binary' }, { value: 'dump', label: 'Hex dump' }],
        },
        newline: { kind: 'bool', label: 'A line each', default: true, live: true },
    },
    create() {
        let p = {};
        return {
            configure(params) { p = params; },
            reset() {},
            process(ins, outs) {
                for (const msg of (ins[0] && ins[0].list) || []) {
                    const bytes = bytesOf(msg);
                    if (!bytes || !outs[0] || !outs[0].list) continue;
                    outs[0].list.push({ type: 'text', text: `${bytesText(bytes, p.format)}${p.newline ? '\n' : ''}` });
                }
                return 0;
            },
        };
    },
};
