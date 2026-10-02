// The character codes of the MFSK family, from fldigi to the entry: MFSK's
// Varicode (IZ8BLY's, src/mfsk/mfskvaricode.cxx), THOR's extension of it for
// a second line of text (src/thor/thorvaricode.cxx), and DominoEX's nibble
// code (src/dominoex/dominovar.cxx). Only the decoding tables are here, as
// fldigi keeps them; the tests carry fldigi's encoding tables, so the two
// check each other.

// ── MFSK Varicode ───────────────────────────────────────────────────────────
//
// A code per character, 3 to 12 bits, each starting with a 1 and none with
// "001" inside it — so "001" marks a boundary: the "00" ends one character
// and the 1 starts the next. mfsk::recvbit keeps the bits in a register that
// starts at 1 (that first 1 of the next character) and, at each "001", looks
// up everything before the final 1. Index: the character; value: its code.
const MFSK_VARIDECODE = [
    0x75C, 0x760, 0x768, 0x76C, 0x770, 0x774, 0x778, 0x77C,
    0x0A8, 0x780, 0x7A0, 0x7A8, 0x7AC, 0x0AC, 0x7B0, 0x7B4,
    0x7B8, 0x7BC, 0x7C0, 0x7D0, 0x7D4, 0x7D8, 0x7DC, 0x7E0,
    0x7E8, 0x7EC, 0x7F0, 0x7F4, 0x7F8, 0x7FC, 0x800, 0xA00,
    0x004, 0x1C0, 0x1FC, 0x2D8, 0x2A8, 0x2A0, 0x200, 0x1BC,
    0x1F4, 0x1F0, 0x2B4, 0x1E0, 0x0A0, 0x1D8, 0x1D4, 0x1E8,
    0x0E0, 0x0F0, 0x140, 0x154, 0x174, 0x160, 0x16C, 0x1A0,
    0x180, 0x1AC, 0x1EC, 0x1F8, 0x2C0, 0x1DC, 0x2BC, 0x1D0,
    0x280, 0x0BC, 0x100, 0x0D4, 0x0DC, 0x0B8, 0x0F8, 0x150,
    0x158, 0x0C0, 0x1B4, 0x17C, 0x0F4, 0x0E8, 0x0FC, 0x0D0,
    0x0EC, 0x1B0, 0x0D8, 0x0B4, 0x0B0, 0x15C, 0x1A8, 0x168,
    0x170, 0x178, 0x1B8, 0x2E8, 0x2D0, 0x2EC, 0x2D4, 0x2B0,
    0x2AC, 0x014, 0x060, 0x038, 0x034, 0x008, 0x050, 0x058,
    0x030, 0x018, 0x080, 0x070, 0x02C, 0x040, 0x01C, 0x010,
    0x054, 0x078, 0x020, 0x028, 0x00C, 0x03C, 0x06C, 0x068,
    0x074, 0x05C, 0x07C, 0x2DC, 0x2B8, 0x2E0, 0x2F0, 0xA80,
    0xAA0, 0xAA8, 0xAAC, 0xAB0, 0xAB4, 0xAB8, 0xABC, 0xAC0,
    0xAD0, 0xAD4, 0xAD8, 0xADC, 0xAE0, 0xAE8, 0xAEC, 0xAF0,
    0xAF4, 0xAF8, 0xAFC, 0xB00, 0xB40, 0xB50, 0xB54, 0xB58,
    0xB5C, 0xB60, 0xB68, 0xB6C, 0xB70, 0xB74, 0xB78, 0xB7C,
    0x2F4, 0x2F8, 0x2FC, 0x300, 0x340, 0x350, 0x354, 0x358,
    0x35C, 0x360, 0x368, 0x36C, 0x370, 0x374, 0x378, 0x37C,
    0x380, 0x3A0, 0x3A8, 0x3AC, 0x3B0, 0x3B4, 0x3B8, 0x3BC,
    0x3C0, 0x3D0, 0x3D4, 0x3D8, 0x3DC, 0x3E0, 0x3E8, 0x3EC,
    0x3F0, 0x3F4, 0x3F8, 0x3FC, 0x400, 0x500, 0x540, 0x550,
    0x554, 0x558, 0x55C, 0x560, 0x568, 0x56C, 0x570, 0x574,
    0x578, 0x57C, 0x580, 0x5A0, 0x5A8, 0x5AC, 0x5B0, 0x5B4,
    0x5B8, 0x5BC, 0x5C0, 0x5D0, 0x5D4, 0x5D8, 0x5DC, 0x5E0,
    0x5E8, 0x5EC, 0x5F0, 0x5F4, 0x5F8, 0x5FC, 0x600, 0x680,
    0x6A0, 0x6A8, 0x6AC, 0x6B0, 0x6B4, 0x6B8, 0x6BC, 0x6C0,
    0x6D0, 0x6D4, 0x6D8, 0x6DC, 0x6E0, 0x6E8, 0x6EC, 0x6F0,
    0x6F4, 0x6F8, 0x6FC, 0x700, 0x740, 0x750, 0x754, 0x758,
];

// THOR's second alphabet: the 12-bit codes MFSK leaves unused, for ' '
// through 'z' (thor_varidecode). thorvaridec looks anything under 0xB80 up in
// MFSK's table and anything from there in this one.
const THOR_VARIDECODE = [
    0xB80, 0xBA0, 0xBA8, 0xBAC, 0xBB0, 0xBB4, 0xBB8, 0xBBC,
    0xBC0, 0xBD0, 0xBD4, 0xBD8, 0xBDC, 0xBE0, 0xBE8, 0xBEC,
    0xBF0, 0xBF4, 0xBF8, 0xBFC, 0xC00, 0xD00, 0xD40, 0xD54,
    0xD58, 0xD5C, 0xD60, 0xD68, 0xD6C, 0xD70, 0xD74, 0xD78,
    0xD7C, 0xD80, 0xDA0, 0xDA8, 0xDAC, 0xDB0, 0xDB4, 0xDB8,
    0xDBC, 0xDC0, 0xDD0, 0xDD4, 0xDD8, 0xDDC, 0xDE0, 0xDE8,
    0xDEC, 0xDF0, 0xDF4, 0xDF8, 0xDFC, 0xE00, 0xE80, 0xEA0,
    0xEAC, 0xEB0, 0xEB4, 0xEB8, 0xEBC, 0xEC0, 0xED0, 0xED4,
    0xED8, 0xEDC, 0xEE0, 0xEE8, 0xEEC, 0xEF0, 0xEF4, 0xEF8,
    0xEFC, 0xF00, 0xF40, 0xF50, 0xF54, 0xF58, 0xF5C, 0xF60,
    0xF68, 0xF6C, 0xF70, 0xF74, 0xF78, 0xF7C, 0xF80, 0xFA0,
    0xFA8, 0xFAC, 0xFB0,
];

const MFSK_INDEX = new Map(MFSK_VARIDECODE.map((code, c) => [code, c]));
const THOR_INDEX = new Map(THOR_VARIDECODE.map((code, i) => [code, 32 + i]));

/**
 * mfsk::recvbit and thor::decodePairs' register, and varidec / thorvaridec:
 * bits in, one at a time; each returns the character it completed, -1 for
 * none (or a code that is not one), with 0x100 added for THOR's second
 * alphabet.
 */
export class MfskVaricode {
    constructor(secondary = false) {
        this.secondary = secondary;
        this.reg = 1;
    }

    reset() { this.reg = 1; }

    push(bit) {
        // An unsigned 32-bit register, as fldigi's: a long run of idle zeros
        // shifts the old bits out the top, as it does there.
        this.reg = ((this.reg << 1) | (bit ? 1 : 0)) >>> 0;
        if ((this.reg & 7) !== 1) return -1;
        const code = this.reg >>> 1;
        this.reg = 1;
        if (this.secondary && code >= 0xb80) {
            const c = THOR_INDEX.get(code);
            return c === undefined ? -1 : c + 0x100;
        }
        const c = MFSK_INDEX.get(code);
        return c === undefined ? -1 : c;
    }
}

// ── DominoEX ────────────────────────────────────────────────────────────────
//
// One to three nibbles a character, one nibble a symbol: the first with its
// top bit clear, any more with it set, so a nibble with the top bit clear
// starts the next character. The 512 codes are 256 primary characters and
// 256 for the second line of text (marked here, as in fldigi, by 0x100). The
// table is varidecode, indexed by the nibbles run together first-most-
// significant; here as fldigi lays it out, sixteen to a row, with the rows
// that hold nothing left out: [row, sixteen characters], -1 for none.
const DOMINO_ROWS = [
    [0x00, 32, 101, 116, 111, 97, 105, 110, 114, 115, 108, 104, 100, 99, 117, 109, 102],
    [0x01, -1, -1, -1, -1, -1, -1, -1, -1, 112, 103, 121, 98, 119, 118, 107, 120],
    [0x02, -1, -1, -1, -1, -1, -1, -1, -1, 113, 122, 106, 44, 8, 13, 84, 83],
    [0x03, -1, -1, -1, -1, -1, -1, -1, -1, 69, 65, 73, 79, 67, 82, 68, 48],
    [0x04, -1, -1, -1, -1, -1, -1, -1, -1, 77, 80, 49, 76, 70, 78, 66, 50],
    [0x05, -1, -1, -1, -1, -1, -1, -1, -1, 71, 51, 72, 85, 53, 87, 54, 88],
    [0x06, -1, -1, -1, -1, -1, -1, -1, -1, 52, 89, 75, 56, 55, 86, 57, 81],
    [0x07, -1, -1, -1, -1, -1, -1, -1, -1, 74, 90, 39, 33, 63, 46, 45, 61],
    [0x08, -1, -1, -1, -1, -1, -1, -1, -1, 43, 47, 58, 41, 40, 59, 34, 38],
    [0x09, -1, -1, -1, -1, -1, -1, -1, -1, 64, 37, 36, 96, 95, 42, 124, 62],
    [0x0A, -1, -1, -1, -1, -1, -1, -1, -1, 60, 92, 94, 35, 123, 125, 91, 93],
    [0x0B, -1, -1, -1, -1, -1, -1, -1, -1, 126, 160, 161, 162, 163, 164, 165, 166],
    [0x0C, -1, -1, -1, -1, -1, -1, -1, -1, 167, 168, 169, 170, 171, 172, 173, 174],
    [0x0D, -1, -1, -1, -1, -1, -1, -1, -1, 175, 176, 177, 178, 179, 180, 181, 182],
    [0x0E, -1, -1, -1, -1, -1, -1, -1, -1, 183, 184, 185, 186, 187, 188, 189, 190],
    [0x0F, -1, -1, -1, -1, -1, -1, -1, -1, 191, 192, 193, 194, 195, 196, 197, 198],
    [0x18, -1, -1, -1, -1, -1, -1, -1, -1, 199, 200, 201, 202, 203, 204, 205, 206],
    [0x19, -1, -1, -1, -1, -1, -1, -1, -1, 207, 208, 209, 210, 211, 212, 213, 214],
    [0x1A, -1, -1, -1, -1, -1, -1, -1, -1, 215, 216, 217, 218, 219, 220, 221, 222],
    [0x1B, -1, -1, -1, -1, -1, -1, -1, -1, 223, 224, 225, 226, 227, 228, 229, 230],
    [0x1C, -1, -1, -1, -1, -1, -1, -1, -1, 231, 232, 233, 234, 235, 236, 237, 238],
    [0x1D, -1, -1, -1, -1, -1, -1, -1, -1, 239, 240, 241, 242, 243, 244, 245, 246],
    [0x1E, -1, -1, -1, -1, -1, -1, -1, -1, 247, 248, 249, 250, 251, 252, 253, 254],
    [0x1F, -1, -1, -1, -1, -1, -1, -1, -1, 255, 0, 1, 2, 3, 4, 5, 6],
    [0x28, -1, -1, -1, -1, -1, -1, -1, -1, 7, 9, 10, 11, 12, 14, 15, 16],
    [0x29, -1, -1, -1, -1, -1, -1, -1, -1, 17, 18, 19, 20, 21, 22, 23, 24],
    [0x2A, -1, -1, -1, -1, -1, -1, -1, -1, 25, 26, 27, 28, 29, 30, 31, 127],
    [0x2B, -1, -1, -1, -1, -1, -1, -1, -1, 128, 129, 130, 131, 132, 133, 134, 135],
    [0x2C, -1, -1, -1, -1, -1, -1, -1, -1, 136, 137, 138, 139, 140, 141, 142, 143],
    [0x2D, -1, -1, -1, -1, -1, -1, -1, -1, 144, 145, 146, 147, 148, 149, 150, 151],
    [0x2E, -1, -1, -1, -1, -1, -1, -1, -1, 152, 153, 154, 155, 156, 157, 158, 159],
    [0x38, -1, -1, -1, -1, -1, -1, -1, -1, 288, 357, 372, 367, 353, 361, 366, 370],
    [0x48, -1, -1, -1, -1, -1, -1, -1, -1, 371, 364, 360, 356, 355, 373, 365, 358],
    [0x49, -1, -1, -1, -1, -1, -1, -1, -1, 368, 359, 377, 354, 375, 374, 363, 376],
    [0x4A, -1, -1, -1, -1, -1, -1, -1, -1, 369, 378, 362, 300, 264, 269, 340, 339],
    [0x4B, -1, -1, -1, -1, -1, -1, -1, -1, 325, 321, 329, 335, 323, 338, 324, 304],
    [0x4C, -1, -1, -1, -1, -1, -1, -1, -1, 333, 336, 305, 332, 326, 334, 322, 306],
    [0x4D, -1, -1, -1, -1, -1, -1, -1, -1, 327, 307, 328, 341, 309, 343, 310, 344],
    [0x4E, -1, -1, -1, -1, -1, -1, -1, -1, 308, 345, 331, 312, 311, 342, 313, 337],
    [0x4F, -1, -1, -1, -1, -1, -1, -1, -1, 330, 346, 295, 289, 319, 302, 301, 317],
    [0x58, -1, -1, -1, -1, -1, -1, -1, -1, 299, 303, 314, 297, 296, 315, 290, 294],
    [0x59, -1, -1, -1, -1, -1, -1, -1, -1, 320, 293, 292, 352, 351, 298, 380, 318],
    [0x5A, -1, -1, -1, -1, -1, -1, -1, -1, 316, 348, 350, 291, 381, -1, 347, 349],
    [0x5B, -1, -1, -1, -1, -1, -1, -1, -1, 382, 416, 417, 418, 419, 420, 421, 422],
    [0x5C, -1, -1, -1, -1, -1, -1, -1, -1, 423, 424, 425, 426, 427, 428, 429, 430],
    [0x5D, -1, -1, -1, -1, -1, -1, -1, -1, 431, 432, 433, 434, 435, 436, 437, 438],
    [0x5E, -1, -1, -1, -1, -1, -1, -1, -1, 439, 440, 441, 442, 443, 444, 445, 446],
    [0x5F, -1, -1, -1, -1, -1, -1, -1, -1, 447, 448, 449, 450, 451, 452, 453, 454],
    [0x68, -1, -1, -1, -1, -1, -1, -1, -1, 455, 456, 457, 458, 459, 460, 461, 462],
    [0x69, -1, -1, -1, -1, -1, -1, -1, -1, 463, 464, 465, 466, 467, 468, 469, 470],
    [0x6A, -1, -1, -1, -1, -1, -1, -1, -1, 471, 472, 473, 474, 475, 476, 477, 478],
    [0x6B, -1, -1, -1, -1, -1, -1, -1, -1, 479, 480, 481, 482, 483, 484, 485, 486],
    [0x6C, -1, -1, -1, -1, -1, -1, -1, -1, 487, 488, 489, 490, 491, 492, 493, 494],
    [0x6D, -1, -1, -1, -1, -1, -1, -1, -1, 495, 496, 497, 498, 499, 500, 501, 502],
    [0x6E, -1, -1, -1, -1, -1, -1, -1, -1, 503, 504, 505, 506, 507, 508, 509, 510],
    [0x6F, -1, -1, -1, -1, -1, -1, -1, -1, 511, 256, 257, 258, 259, 260, 261, 262],
    [0x78, -1, -1, -1, -1, -1, -1, -1, -1, 263, 265, 266, 267, 268, 270, 271, 272],
    [0x79, -1, -1, -1, -1, -1, -1, -1, -1, 273, 274, 275, 276, 277, 278, 279, 280],
    [0x7A, -1, -1, -1, -1, -1, -1, -1, -1, 281, 282, 283, 284, 285, 286, 287, 383],
    [0x7B, -1, -1, -1, -1, -1, -1, -1, -1, 384, 385, 386, 387, 388, 389, 390, 391],
    [0x7C, -1, -1, -1, -1, -1, -1, -1, -1, 392, 393, 394, 395, 396, 397, 398, 399],
    [0x7D, -1, -1, -1, -1, -1, -1, -1, -1, 400, 401, 402, 403, 404, 405, 406, 407],
    [0x7E, -1, -1, -1, -1, -1, -1, -1, -1, 408, 409, 410, 411, 412, 413, 414, 415],
];

const DOMINO_VARIDECODE = new Int16Array(4096).fill(-1);
for (const [row, ...chars] of DOMINO_ROWS) DOMINO_VARIDECODE.set(chars, row * 16);

// Longest code, in nibbles (dominovar.h MAX_VARICODE_LEN).
const DOMINO_MAX_LEN = 3;

/**
 * dominoex::decodeDomino: nibbles in, one per symbol; each returns the
 * character the nibble finished off (the one before it), or -1.
 */
export class DominoVaricode {
    constructor() { this.reset(); }

    reset() {
        this.buf = [0, 0, 0];
        this.count = 0;
    }

    push(nibble) {
        let ch = -1;
        if (!(nibble & 8)) {
            if (this.count > 0 && this.count <= DOMINO_MAX_LEN) {
                let sym = 0;
                for (let i = 0; i < this.count; i++) sym |= this.buf[i] << (4 * i);
                ch = DOMINO_VARIDECODE[sym & 0xfff];
            }
            this.count = 0;
        }
        // Newest first, as fldigi's symbolbuf.
        this.buf[2] = this.buf[1];
        this.buf[1] = this.buf[0];
        this.buf[0] = nibble & 15;
        this.count = Math.min(this.count + 1, DOMINO_MAX_LEN + 1);
        return ch;
    }
}

// ── to text ─────────────────────────────────────────────────────────────────

/**
 * What a decoded character prints as. fldigi ends lines with a carriage
 * return in some modes and CR LF in others, and frames each transmission in
 * CR STX CR … CR EOT CR; a console wants line feeds and no control codes. So
 * a CR is a line feed, an LF straight after one is dropped, and the rest of
 * the control codes are nothing. Above 127 is Latin-1, as fldigi shows it.
 * `state` carries whether the last was a CR.
 */
export function printable(c, state) {
    const afterCr = state.cr;
    state.cr = c === 13;
    if (c === 13) return '\n';
    if (c === 10) return afterCr ? '' : '\n';
    if (c < 32 || c === 127 || c > 255) return '';
    return String.fromCharCode(c);
}
