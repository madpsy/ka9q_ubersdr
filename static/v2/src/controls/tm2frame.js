// The ELAD TM-2's output report: every LCD segment, both LEDs, the RGB
// backlight, the contrast and the main encoder's acceleration, as one frame.
//
// The TM-2 (sold before 2021 as the Woodbox Radio TMate 2) is a plain USB HID
// with no driver. ELAD's own SDK is Windows-only and only on request, so the
// layout here is the one github.com/microenh/Tmate2_C drives a real unit with:
// its tmate2/bitfields.h gives the bit of every field (the names are ELAD's,
// from their Tmate2LcdSegment document), and main_layout.c / smeter_layout.c
// the seven-segment fonts. test/tm2.tmate2c.json holds frames produced by that
// code itself (test/tm2ref/tm2gen.c), and the tests hold this file to them
// byte for byte.
//
// The frame is 45 bytes in Tmate2_C's numbering: byte 0 is the report ID (0,
// the device does not number its reports) and bytes 1..43 are the report. Its
// last field, trans_time (byte 44), is never sent — tmate2.c writes 44 bytes —
// and is kept only so the offsets read the same as bitfields.h.
//
// Pure: nothing here knows about WebHID or the receiver. tm2display.js decides
// what to show, tm2.js sends it.

export const FRAME_BYTES = 45;
export const OUTPUT_PAYLOAD = 43;

// name -> [bit offset from the start of the frame, width]. LSB first within a
// byte, as GCC packs bitfields.h's `#pragma pack(1)` bitfields with
// -mno-ms-bitfields (Tmate2_C's CMakeLists) — which the device reads.
export const FIELDS = {
    lp: [9, 1], rx: [10, 1], tx: [11, 1], s: [12, 1], vfo: [13, 1], nr: [14, 1],
    e1: [15, 1], att: [16, 1], smeter_bar_1: [17, 1], smeter_bar_2: [18, 1], smeter_bar_3: [19, 1], smeter_1: [20, 1],
    a: [21, 1], nb: [22, 1], vol: [23, 1], smeter_line: [24, 1], smeter_9: [25, 1], smeter_7: [26, 1],
    smeter_5: [27, 1], smeter_3: [28, 1], b: [29, 1], an: [30, 1], rfg: [31, 1], main_9l: [32, 4],
    sql: [36, 1], main_9r: [40, 3], underline_9: [43, 1], drv: [44, 1], main_8l: [48, 4], nr2: [52, 1],
    main_8r: [56, 3], underline_8: [59, 1], nb2: [60, 1], main_7l: [64, 4], an2: [68, 1], main_7r: [72, 3],
    underline_7: [75, 1], e2: [76, 1], smeter_10: [77, 1], main_6l: [80, 4], dot1: [84, 1], smeter_plus20: [85, 1],
    main_6r: [88, 3], underline_6: [91, 1], high: [92, 1], smeter_20: [93, 1], main_5l: [96, 4], low: [100, 1],
    main_5r: [104, 3], underline_5: [107, 1], shift: [108, 1], main_4l: [112, 4], rit: [116, 1], main_4r: [120, 3],
    underline_4: [123, 1], xit: [124, 1], main_3l: [128, 4], dot2: [132, 1], smeter_plus40: [133, 1], main_3r: [136, 3],
    underline_3: [139, 1], smeter_40: [141, 1], main_2l: [144, 4], main_2r: [152, 3], underline_2: [155, 1], smeter_plus60: [157, 1],
    main_1l: [160, 4], err: [164, 1], smeter_60: [165, 1], main_1r: [168, 3], underline_1: [171, 1], w_fm: [172, 1],
    w: [173, 1], cw_plus: [176, 1], cw_minus: [177, 1], dig_plus: [178, 1], dig_minus: [179, 1], dsb: [180, 1],
    fm: [181, 1], usb: [182, 1], sam: [183, 1], drm: [184, 1], dig: [185, 1], stereo: [186, 1],
    dbm: [188, 1], cw: [189, 1], lsb: [190, 1], am: [191, 1], hz: [192, 1], smeter_1r: [196, 4],
    smeter_1l: [205, 3], k: [208, 1], smeter_2r: [212, 4], smeter_2l: [221, 3], mw_w: [224, 1], smeter_3r: [228, 4],
    mw_m: [232, 1], smeter_db_minus: [236, 1], smeter_3l: [237, 3], smeter_bar15: [244, 1], smeter_bar14: [245, 1], smeter_bar13: [246, 1],
    smeter_bar12: [247, 1], pre_1: [248, 1], pre_2: [249, 1], smeter_bar8: [252, 1], smeter_bar9: [253, 1], smeter_bar10: [254, 1],
    smeter_bar11: [255, 1], att_2: [256, 1], pre: [257, 1], att_1: [258, 1], smeter_bar7: [260, 1], smeter_bar6: [261, 1],
    smeter_bar5: [262, 1], smeter_bar4: [263, 1], usb_led: [264, 1], lock_led: [265, 1], click: [266, 1], rgb_red: [272, 8],
    rgb_green: [280, 8], rgb_blue: [288, 8], contrast: [296, 8], refresh: [304, 8], encoder_speed1: [312, 8], encoder_speed2: [320, 8],
    encoder_speed3: [328, 8], encoder_trans12: [336, 8], encoder_trans23: [344, 8], trans_time: [352, 8],
};

// Seven-segment fonts for ASCII 32 (' ') to 90 ('Z'), [left, right] as
// Tmate2_C's tables have them. Anything outside that range is a space.
//   main digits:    left bit0 f, bit1 g, bit2 e, bit3 d — right bit0 a, bit1 b, bit2 c
//   S-meter digits: left bit0 e, bit1 g, bit2 f        — right bit0 d, bit1 c, bit2 b, bit3 a
const MAIN_FONT = [
    [0b0000, 0b000], [0b0000, 0b010], [0b0001, 0b010], [0b0101, 0b110], [0b1011, 0b101], [0b0001, 0b100], [0b0000, 0b000], [0b0001, 0b000], [0b1101, 0b001], [0b1000, 0b111],
    [0b0111, 0b110], [0b0010, 0b110], [0b0100, 0b000], [0b0010, 0b000], [0b0100, 0b000], [0b0100, 0b010], [0b1101, 0b111], [0b0000, 0b110], [0b1110, 0b011], [0b1010, 0b111],
    [0b0011, 0b110], [0b1011, 0b101], [0b1111, 0b101], [0b0000, 0b111], [0b1111, 0b111], [0b1011, 0b111], [0b0100, 0b000], [0b0100, 0b000], [0b1101, 0b001], [0b1010, 0b000],
    [0b1000, 0b111], [0b0110, 0b111], [0b1111, 0b011], [0b0111, 0b111], [0b1111, 0b100], [0b1110, 0b000], [0b1110, 0b110], [0b1111, 0b001], [0b0111, 0b001], [0b1111, 0b101],
    [0b0111, 0b100], [0b0000, 0b100], [0b1000, 0b110], [0b0111, 0b110], [0b1101, 0b000], [0b0110, 0b100], [0b0110, 0b100], [0b1110, 0b100], [0b0111, 0b011], [0b1110, 0b100],
    [0b0110, 0b000], [0b1011, 0b101], [0b1111, 0b000], [0b1100, 0b100], [0b1100, 0b100], [0b1100, 0b100], [0b0111, 0b110], [0b0011, 0b110], [0b1110, 0b011],
];
const SMETER_FONT = [
    [0b000, 0b0000], [0b000, 0b0100], [0b100, 0b0100], [0b101, 0b0110], [0b110, 0b1011], [0b100, 0b0010], [0b000, 0b0000], [0b100, 0b0000], [0b101, 0b1001], [0b000, 0b1111],
    [0b111, 0b0110], [0b010, 0b0110], [0b001, 0b0000], [0b010, 0b0000], [0b001, 0b0000], [0b001, 0b0100], [0b101, 0b1111], [0b000, 0b0110], [0b011, 0b1101], [0b010, 0b1111],
    [0b110, 0b0110], [0b110, 0b1011], [0b111, 0b1011], [0b000, 0b1110], [0b111, 0b1111], [0b110, 0b1111], [0b001, 0b0000], [0b001, 0b0000], [0b101, 0b1001], [0b010, 0b0001],
    [0b000, 0b1111], [0b011, 0b1110], [0b111, 0b1101], [0b111, 0b1110], [0b111, 0b0011], [0b011, 0b0001], [0b011, 0b0111], [0b111, 0b1001], [0b111, 0b1000], [0b111, 0b1011],
    [0b111, 0b0010], [0b000, 0b0010], [0b000, 0b0111], [0b111, 0b0110], [0b101, 0b0001], [0b011, 0b0010], [0b011, 0b0010], [0b011, 0b0011], [0b111, 0b1100], [0b011, 0b0011],
    [0b011, 0b0000], [0b110, 0b1011], [0b111, 0b0001], [0b001, 0b0011], [0b001, 0b0011], [0b001, 0b0011], [0b111, 0b0110], [0b110, 0b0110], [0b011, 0b1101],
];

// The S-meter bar, left to right. Tmate2_C names the first three
// smeter_bar_1..3 and the rest smeter_bar4..15; the photographs show the
// first three drawn larger.
export const BAR_FIELDS = [
    'smeter_bar_1', 'smeter_bar_2', 'smeter_bar_3', 'smeter_bar4', 'smeter_bar5',
    'smeter_bar6', 'smeter_bar7', 'smeter_bar8', 'smeter_bar9', 'smeter_bar10',
    'smeter_bar11', 'smeter_bar12', 'smeter_bar13', 'smeter_bar14', 'smeter_bar15',
];

// Main-display digit positions: 1 is the rightmost (units), 9 the leftmost.
export const MAIN_DIGITS = 9;
export const SMETER_DIGITS = 3;

export function newFrame() {
    return new Uint8Array(FRAME_BYTES);
}

export function setField(frame, name, value) {
    const f = FIELDS[name];
    if (!f) throw new Error(`no TM-2 field "${name}"`);
    const [offset, width] = f;
    for (let i = 0; i < width; i += 1) {
        const bit = offset + i;
        const mask = 1 << (bit & 7);
        if ((value >> i) & 1) frame[bit >> 3] |= mask;
        else frame[bit >> 3] &= ~mask;
    }
}

export function getField(frame, name) {
    const [offset, width] = FIELDS[name];
    let v = 0;
    for (let i = 0; i < width; i += 1) {
        const bit = offset + i;
        if (frame[bit >> 3] & (1 << (bit & 7))) v |= 1 << i;
    }
    return v;
}

function glyph(font, ch) {
    const i = String(ch || ' ').toUpperCase().charCodeAt(0) - 32;
    return font[i] || font[0];
}

/** One main-display digit, `pos` 1 (rightmost) .. 9 (leftmost). update_main_digit. */
export function mainDigit(frame, pos, ch) {
    const [l, r] = glyph(MAIN_FONT, ch);
    setField(frame, `main_${pos}l`, l);
    setField(frame, `main_${pos}r`, r);
}

/** One S-meter digit, `pos` 1 (rightmost) .. 3. update_smeter_digit. */
export function smeterDigit(frame, pos, ch) {
    const [l, r] = glyph(SMETER_FONT, ch);
    setField(frame, `smeter_${pos}l`, l);
    setField(frame, `smeter_${pos}r`, r);
}

/**
 * A number on the main display, as display_main_number: leading zeros blank,
 * a minus in the ninth place, and anything past nine digits blanks it.
 *
 * The two dots group it as MHz.kHz.Hz. One deliberate difference: Tmate2_C
 * lights them for values *over* 1 000 000 and 1 000, so exactly 1.000.000 Hz
 * would show without its MHz dot; here it is "at least".
 */
export function displayMainNumber(frame, value) {
    let v = Math.round(Number(value) || 0);
    const blank = v > 999999999;
    mainDigit(frame, 9, v < 0 && !blank ? '-' : ' ');
    v = Math.abs(v);
    setField(frame, 'dot1', v >= 1000000 && !blank ? 1 : 0);
    setField(frame, 'dot2', v >= 1000 && !blank ? 1 : 0);
    for (let i = 0; i < 8; i += 1) {
        const n = v % 10;
        v = Math.floor(v / 10);
        mainDigit(frame, i + 1, (n === 0 && v === 0 && i > 0) || blank ? ' ' : String(n));
    }
}

/** Up to nine characters, right-aligned, dots off. Seven segments read A–Z and 0–9, some better than others. */
export function displayMainText(frame, text) {
    const s = String(text || '').toUpperCase().slice(0, MAIN_DIGITS).padStart(MAIN_DIGITS, ' ');
    setField(frame, 'dot1', 0);
    setField(frame, 'dot2', 0);
    for (let pos = 1; pos <= MAIN_DIGITS; pos += 1) mainDigit(frame, pos, s[MAIN_DIGITS - pos]);
}

/**
 * The S-meter's three digits, as display_smeter_number: a minus of its own
 * (smeter_db_minus) for negatives, and anything over 999 blanks it — 1000 is
 * Tmate2_C's way of saying "nothing". Below -999 is clamped rather than blanked.
 */
export function displaySmeterNumber(frame, value) {
    let v = Math.round(Number(value));
    if (!Number.isFinite(v)) v = 1000;
    if (v < -999) v = -999;
    const blank = v > 999;
    setField(frame, 'smeter_db_minus', v < 0 && !blank ? 1 : 0);
    v = Math.abs(v);
    for (let i = 0; i < SMETER_DIGITS; i += 1) {
        const n = v % 10;
        v = Math.floor(v / 10);
        smeterDigit(frame, i + 1, (n === 0 && v === 0 && i > 0) || blank ? ' ' : String(n));
    }
}

/** The printed S-meter scale and its line, as set_smeter_graph. */
export function setSmeterGraph(frame, on) {
    for (const f of ['smeter_line', 'smeter_1', 'smeter_3', 'smeter_5', 'smeter_7', 'smeter_9',
        'smeter_10', 'smeter_20', 'smeter_40', 'smeter_60']) {
        setField(frame, f, on ? 1 : 0);
    }
}

/**
 * S-units rather than watts, as set_smeter_s: "S" and the plus signs that make
 * 20/40/60 read +20/+40/+60, and "W" (the power scale's label) off. Off is the
 * other way round.
 */
export function setSmeterS(frame, on) {
    setField(frame, 'w', on ? 0 : 1);
    for (const f of ['s', 'smeter_plus20', 'smeter_plus40', 'smeter_plus60']) setField(frame, f, on ? 1 : 0);
}

/** The first `n` of the 15 bar segments lit, the rest dark. */
export function setBars(frame, n) {
    const lit = Math.max(0, Math.min(BAR_FIELDS.length, Math.floor(Number(n) || 0)));
    BAR_FIELDS.forEach((f, i) => setField(frame, f, i < lit ? 1 : 0));
}

export function setRgb(frame, r, g, b) {
    setField(frame, 'rgb_red', r & 0xff);
    setField(frame, 'rgb_green', g & 0xff);
    setField(frame, 'rgb_blue', b & 0xff);
}

/** main_encoder_setup. Each value is a byte: Tmate2_C's 1000 goes out as 232. */
export function encoderSetup(frame, speed1, speed2, speed3, trans12, trans23, transTime) {
    setField(frame, 'encoder_speed1', speed1 & 0xff);
    setField(frame, 'encoder_speed2', speed2 & 0xff);
    setField(frame, 'encoder_speed3', speed3 & 0xff);
    setField(frame, 'encoder_trans12', trans12 & 0xff);
    setField(frame, 'encoder_trans23', trans23 & 0xff);
    setField(frame, 'trans_time', transTime & 0xff);
}

/**
 * The report as sent: the frame after its report-ID byte, padded with zeros
 * to `length` if the descriptor declares a longer one. sendReport takes the ID
 * separately.
 */
export function tm2Payload(frame, length = OUTPUT_PAYLOAD) {
    const p = new Uint8Array(Math.max(OUTPUT_PAYLOAD, length | 0));
    p.set(frame.subarray(1, 1 + OUTPUT_PAYLOAD));
    return p;
}

export function framesEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
    return true;
}
