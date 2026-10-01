// The character codes the digital decoders speak: ITA2 (RTTY), Varicode
// (PSK31) and Morse. Each comes with its encoder as well as its decoder — the
// tests make real signals from text and require the same text back, and the
// encoders are how they make them.

// ── ITA2 / Baudot, as RTTY sends it ──────────────────────────────────────────
//
// Five bits, two shifts. The tables are the server's (audio_extensions/fsk/
// ita2.go): the US-TTY variant amateurs use, where BEL, $, #, ', " and ; sit
// where US teleprinters put them rather than where ITA2 proper does.

export const ITA2_LTRS = 0x1f;
export const ITA2_FIGS = 0x1b;

const NUL = '';
export const ITA2_LETTERS = [
    NUL, 'E', '\n', 'A', ' ', 'S', 'I', 'U', '\r', 'D', 'R', 'J', 'N', 'F', 'C', 'K',
    'T', 'Z', 'L', 'W', 'H', 'Y', 'P', 'Q', 'O', 'B', 'G', NUL, 'M', 'X', 'V', NUL,
];
export const ITA2_FIGURES = [
    NUL, '3', '\n', '-', ' ', '\x07', '8', '7', '\r', '$', '4', "'", ',', '!', ':', '(',
    '5', '"', ')', '2', '#', '6', '0', '1', '9', '?', '&', NUL, '.', '/', ';', NUL,
];

/**
 * Decodes ITA2 codes, keeping the shift between calls. `unshiftOnSpace` is
 * the usual teleprinter rule that a space drops back to letters, which keeps
 * one lost FIGS from turning the rest of a line into digits.
 */
export class Ita2Decoder {
    constructor({ unshiftOnSpace = true } = {}) {
        this.figs = false;
        this.unshiftOnSpace = unshiftOnSpace;
    }

    reset() { this.figs = false; }

    /** One code, 0–31: the text it stands for, '' for a shift or nothing. */
    decode(code) {
        const c = code & 31;
        if (c === ITA2_LTRS) { this.figs = false; return ''; }
        if (c === ITA2_FIGS) { this.figs = true; return ''; }
        const ch = (this.figs ? ITA2_FIGURES : ITA2_LETTERS)[c];
        if (c === 4 && this.unshiftOnSpace) this.figs = false;
        return ch;
    }
}

/** Text to ITA2 codes, with the shifts it needs. For the tests' signals. */
export function encodeIta2(text) {
    const codes = [];
    let figs = null;
    for (const raw of String(text).toUpperCase()) {
        const ch = raw === '\n' ? '\n' : raw;
        let c = ITA2_LETTERS.indexOf(ch);
        if (c > 0 && ch !== ' ' && ch !== '\n' && ch !== '\r') {
            if (figs !== false) { codes.push(ITA2_LTRS); figs = false; }
            codes.push(c);
            continue;
        }
        if (ch === ' ' || ch === '\n' || ch === '\r') {
            codes.push(ITA2_LETTERS.indexOf(ch));
            // Unshift-on-space, mirrored, so the decoder and this agree.
            if (ch === ' ') figs = false;
            continue;
        }
        c = ITA2_FIGURES.indexOf(ch);
        if (c > 0) {
            if (figs !== true) { codes.push(ITA2_FIGS); figs = true; }
            codes.push(c);
        }
    }
    return codes;
}

// ── Varicode, as PSK31 sends it ──────────────────────────────────────────────
//
// A prefix-free code for ASCII 0–127 in which no character contains two zeros
// in a row, so "00" can separate characters: the receiver collects bits until
// it sees two zeros, and what came before them is one character. Common
// letters are short — 'e' is "11" — which is what lets PSK31 keep up with
// typing at 31 baud. Checked entry for entry against fldigi's table.
export const VARICODE = [
    '1010101011', '1011011011', '1011101101', '1101110111', '1011101011', '1101011111', '1011101111', '1011111101',
    '1011111111', '11101111', '11101', '1101101111', '1011011101', '11111', '1101110101', '1110101011',
    '1011110111', '1011110101', '1110101101', '1110101111', '1101011011', '1101101011', '1101101101', '1101010111',
    '1101111011', '1101111101', '1110110111', '1101010101', '1101011101', '1110111011', '1011111011', '1101111111',
    '1', '111111111', '101011111', '111110101', '111011011', '1011010101', '1010111011', '101111111',
    '11111011', '11110111', '101101111', '111011111', '1110101', '110101', '1010111', '110101111',
    '10110111', '10111101', '11101101', '11111111', '101110111', '101011011', '101101011', '110101101',
    '110101011', '110110111', '11110101', '110111101', '111101101', '1010101', '111010111', '1010101111',
    '1010111101', '1111101', '11101011', '10101101', '10110101', '1110111', '11011011', '11111101',
    '101010101', '1111111', '111111101', '101111101', '11010111', '10111011', '11011101', '10101011',
    '11010101', '111011101', '10101111', '1101111', '1101101', '101010111', '110110101', '101011101',
    '101110101', '101111011', '1010101101', '111110111', '111101111', '111111011', '1010111111', '101101101',
    '1011011111', '1011', '1011111', '101111', '101101', '11', '111101', '1011011',
    '101011', '1101', '111101011', '10111111', '11011', '111011', '1111', '111',
    '111111', '110111111', '10101', '10111', '101', '110111', '1111011', '1101011',
    '11011111', '1011101', '111010101', '1010110111', '110111011', '1010110101', '1011010111', '1110110101',
];

const VARICODE_INDEX = new Map(VARICODE.map((c, i) => [c, i]));

/** Varicode bits to text. Feed bits one at a time; a character comes out after its "00". */
export class VaricodeDecoder {
    constructor() { this.code = ''; this.zeros = 0; }

    reset() { this.code = ''; this.zeros = 0; }

    /** One bit, 0 or 1: the character it completes, or ''. */
    push(bit) {
        if (bit) {
            this.zeros = 0;
            this.code += '1';
            // Longer than any code: noise, not a character. Start again.
            if (this.code.length > 12) this.code = '';
            return '';
        }
        this.zeros++;
        if (this.zeros === 1) {
            this.code += '0';
            return '';
        }
        // Two zeros: what came before the first is a character.
        const code = this.code.slice(0, -1);
        this.code = '';
        if (this.zeros > 2 || !code) return '';
        const i = VARICODE_INDEX.get(code);
        if (i === undefined) return '';
        // Line feeds as they come; the control codes nobody can see, not at all.
        if (i === 10 || i >= 32) return String.fromCharCode(i);
        return '';
    }
}

/** Text to Varicode bits, each character followed by "00". */
export function encodeVaricode(text) {
    const bits = [];
    for (const ch of String(text)) {
        const c = VARICODE[ch.charCodeAt(0) & 127];
        for (const b of c) bits.push(b === '1' ? 1 : 0);
        bits.push(0, 0);
    }
    return bits;
}

// ── Morse ───────────────────────────────────────────────────────────────────

export const MORSE = {
    'A': '.-', 'B': '-...', 'C': '-.-.', 'D': '-..', 'E': '.', 'F': '..-.', 'G': '--.', 'H': '....', 'I': '..', 'J': '.---',
    'K': '-.-', 'L': '.-..', 'M': '--', 'N': '-.', 'O': '---', 'P': '.--.', 'Q': '--.-', 'R': '.-.', 'S': '...', 'T': '-',
    'U': '..-', 'V': '...-', 'W': '.--', 'X': '-..-', 'Y': '-.--', 'Z': '--..',
    '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-', '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.',
    '.': '.-.-.-', ',': '--..--', '?': '..--..', '/': '-..-.', '=': '-...-', '+': '.-.-.', '-': '-....-',
    '(': '-.--.', ')': '-.--.-', ':': '---...', "'": '.----.', '"': '.-..-.', '@': '.--.-.', '!': '-.-.--',
    '&': '.-...', ';': '-.-.-.', '_': '..--.-',
};

const MORSE_INDEX = new Map(Object.entries(MORSE).map(([k, v]) => [v, k]));

/** The character a dot-and-dash pattern stands for, or '*' for one that is not a character. */
export function morseChar(pattern) {
    return MORSE_INDEX.get(pattern) || (pattern ? '*' : '');
}

/**
 * Text as Morse key-down/key-up durations, in dit lengths: 1 for a dit, 3 for
 * a dah, gaps of 1 between elements, 3 between characters and 7 between
 * words. Returns [[on, units], …].
 */
export function encodeMorse(text) {
    const out = [];
    const words = String(text).toUpperCase().trim().split(/\s+/);
    words.forEach((w, wi) => {
        [...w].forEach((ch, ci) => {
            const p = MORSE[ch];
            if (!p) return;
            [...p].forEach((e, ei) => {
                out.push([true, e === '.' ? 1 : 3]);
                if (ei < p.length - 1) out.push([false, 1]);
            });
            if (ci < w.length - 1) out.push([false, 3]);
        });
        if (wi < words.length - 1) out.push([false, 7]);
    });
    return out;
}

// ── CCIR 476, as SITOR-B and NAVTEX send it ──────────────────────────────────
//
// Seven bits, every valid code exactly four of them marks — so a single bit in
// error always shows. The tables, and the phasing and repetition scheme, are
// the server's NAVTEX decoder's (audio_extensions/navtex/ccir476.go). Bits go
// least significant first, mark as 1.

export const CCIR_ALPHA = 0x0f;
export const CCIR_BETA = 0x33;
export const CCIR_C32 = 0x6a;
export const CCIR_REP = 0x66;
export const CCIR_LTRS = 0x5a;
export const CCIR_FIGS = 0x36;

/** Whether a 7-bit code has exactly four marks. */
export const ccirValid = (v) => {
    let n = 0;
    for (let x = v & 127; x; x &= x - 1) n++;
    return n === 4;
};

const ccirTable = (pairs) => {
    const t = new Array(128).fill('');
    for (const [code, ch] of pairs) t[code] = ch;
    return t;
};
export const CCIR_LETTERS = ccirTable([
    [0x17, 'J'], [0x1b, 'F'], [0x1d, 'C'], [0x1e, 'K'], [0x27, 'W'], [0x2b, 'Y'], [0x2d, 'P'], [0x2e, 'Q'],
    [0x35, 'G'], [0x39, 'M'], [0x3a, 'X'], [0x3c, 'V'], [0x47, 'A'], [0x4b, 'S'], [0x4d, 'I'], [0x4e, 'U'],
    [0x53, 'D'], [0x55, 'R'], [0x56, 'E'], [0x59, 'N'], [0x5c, ' '], [0x63, 'Z'], [0x65, 'L'], [0x69, 'H'],
    [0x6c, '\n'], [0x71, 'O'], [0x72, 'B'], [0x74, 'T'], [0x78, '\r'],
]);
export const CCIR_FIGURES = ccirTable([
    [0x17, "'"], [0x1b, '!'], [0x1d, ':'], [0x1e, '('], [0x27, '2'], [0x2b, '6'], [0x2d, '0'], [0x2e, '1'],
    [0x35, '&'], [0x39, '.'], [0x3a, '/'], [0x3c, ';'], [0x47, '-'], [0x4b, '\x07'], [0x4d, '8'], [0x4e, '7'],
    [0x53, '$'], [0x55, '4'], [0x56, '3'], [0x59, ','], [0x5c, ' '], [0x63, '"'], [0x65, ')'], [0x69, '#'],
    [0x6c, '\n'], [0x71, '9'], [0x72, '?'], [0x74, '5'], [0x78, '\r'],
]);

/**
 * SITOR-B's forward error correction: every character is sent twice, first
 * in a DX ("rep") slot and again five slots later in an RX ("alpha") slot,
 * the two kinds of slot alternating. A character is taken from the RX slot
 * if that arrived with four marks, else from its DX copy if that did — so a
 * burst that ruins one copy leaves the other. Phasing codes (REP in DX slots,
 * ALPHA in RX) say which slot is which.
 */
export class SitorDecoder {
    constructor() { this.reset(); }

    reset() {
        this.figs = false;
        this.alpha = false;
        this.c1 = 0;
        this.c2 = 0;
        this.c3 = 0;
    }

    /** One 7-bit code: `{ text, ok }` — ok false where neither copy was valid. */
    push(code) {
        const valid = ccirValid(code);
        if (code === CCIR_REP) this.alpha = false;
        else if (code === CCIR_ALPHA) this.alpha = true;
        let out = { text: '', ok: true };
        if (!this.alpha) {
            this.c1 = this.c2;
            this.c2 = this.c3;
            this.c3 = code;
        } else {
            let chr = -1;
            if (valid) chr = code;
            else if (ccirValid(this.c1)) chr = this.c1;
            if (chr < 0) out = { text: '', ok: false };
            else if (chr === CCIR_LTRS) this.figs = false;
            else if (chr === CCIR_FIGS) this.figs = true;
            else if (chr !== CCIR_REP && chr !== CCIR_ALPHA && chr !== CCIR_BETA && chr !== CCIR_C32) {
                out = { text: (this.figs ? CCIR_FIGURES : CCIR_LETTERS)[chr] || '', ok: true };
            }
        }
        this.alpha = !this.alpha;
        return out;
    }
}

/**
 * Text as a SITOR-B transmission's codes, slot by slot: a phasing preamble of
 * REP and ALPHA, then each character in a DX slot and again five slots later
 * in an RX slot. For the tests' signals.
 */
export function encodeSitorB(text, { phasing = 24 } = {}) {
    const chars = [];
    let figs = null;
    for (const raw of String(text).toUpperCase()) {
        let c = CCIR_LETTERS.indexOf(raw);
        const neutral = raw === ' ' || raw === '\n' || raw === '\r';
        if (c > 0 && !neutral) {
            if (figs !== false) { chars.push(CCIR_LTRS); figs = false; }
            chars.push(c);
            continue;
        }
        if (neutral) { chars.push(CCIR_LETTERS.indexOf(raw)); continue; }
        c = CCIR_FIGURES.indexOf(raw);
        if (c > 0) {
            if (figs !== true) { chars.push(CCIR_FIGS); figs = true; }
            chars.push(c);
        }
    }
    const out = [];
    for (let k = 0; k < phasing; k++) out.push(CCIR_REP, CCIR_ALPHA);
    for (let k = 0; k < chars.length + 2; k++) {
        out.push(k < chars.length ? chars[k] : CCIR_REP);
        out.push(k >= 2 ? chars[k - 2] : CCIR_ALPHA);
    }
    for (let k = 0; k < 6; k++) out.push(CCIR_REP, CCIR_ALPHA);
    return out;
}
