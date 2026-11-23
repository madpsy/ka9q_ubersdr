// The TM-2's start-up show: about four seconds of every segment, the LEDs
// and a cycling backlight, ending on "UbErSdr" before the receiver takes the
// display. Played once a connection opens, if the display settings allow
// (tm2display.js, `intro`); any knob or key stops it at once.
//
// Pure: introFrame(t, base) is the frame t ms in. `base` is the frame the
// receiver would show now (renderTm2) — the show keeps its contrast, encoder
// acceleration and click bit, and fades its backlight into base's colour, so
// handing over at the end changes only the segments.
//
//   0      SWEEP_END   every digit drawn a segment at a time, the bar filling,
//                      the annunciators sparkling in — rainbow backlight
//   ...    CHASE_END   each digit a spinner, the bar a scanner, LEDs alternate
//   ...    FULL_END    everything lit, white
//   ...    INTRO_MS    the name spelled in over the eights, the bar draining,
//                      the backlight easing back to the operator's colour;
//                      the finished name holds for the last second
//
// Seven segments cannot tell B from 8, D from 0 or R from A, so the name is
// the font's lowercase-looking b, d and r — which is what the font draws for
// those letters anyway.

import { BAR_FIELDS, FIELDS, MAIN_DIGITS, SMETER_DIGITS, displayMainText, getField, setField } from './tm2frame.js';

export const INTRO_MS = 4000;
// The driver redraws this often while it plays.
export const INTRO_STEP_MS = 40;
export const INTRO_TEXT = ' UBERSDR ';

const SWEEP_END = 1000;
const CHASE_END = 2100;
const FULL_END = 2400;
const LETTER_MS = 65;
const DRAIN_MS = 40;
const RAINBOW_MS = 1200;      // one turn of the hue wheel
const EASE_FROM = 3000;
const EASE_TO = 3700;

// Each segment of a digit as [half, bit] — the fonts' layouts in tm2frame.js.
const MAIN_SEG = {
    a: ['r', 0], b: ['r', 1], c: ['r', 2], d: ['l', 3], e: ['l', 2], f: ['l', 0], g: ['l', 1],
};
const SMETER_SEG = {
    a: ['r', 3], b: ['r', 2], c: ['r', 1], d: ['r', 0], e: ['l', 0], f: ['l', 2], g: ['l', 1],
};
const DRAW_ORDER = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
const RING = ['a', 'b', 'c', 'd', 'e', 'f'];

// Not segments: what the frame carries besides the LCD and the LEDs.
const HARDWARE = new Set(['click', 'rgb_red', 'rgb_green', 'rgb_blue', 'contrast', 'refresh',
    'encoder_speed1', 'encoder_speed2', 'encoder_speed3', 'encoder_trans12', 'encoder_trans23', 'trans_time']);
const LEDS = ['usb_led', 'lock_led'];
const DIGIT_FIELD = /^(main|smeter)_\d[lr]$/;
const BARS = new Set(BAR_FIELDS);

/** Every LCD field, digits included: what the show owns. */
export const SEGMENT_FIELDS = Object.keys(FIELDS).filter((n) => !HARDWARE.has(n) && !LEDS.includes(n));

// The single segments that are neither a digit nor the bar, in a fixed
// scramble so they sparkle in rather than fill in bit order.
const SPARKLE = SEGMENT_FIELDS.filter((n) => !DIGIT_FIELD.test(n) && !BARS.has(n));
for (let i = SPARKLE.length - 1, seed = 7; i > 0; i -= 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const j = seed % (i + 1);
    [SPARKLE[i], SPARKLE[j]] = [SPARKLE[j], SPARKLE[i]];
}

function segOn(frame, kind, pos, seg) {
    const [half, bit] = (kind === 'main' ? MAIN_SEG : SMETER_SEG)[seg];
    const name = `${kind}_${pos}${half}`;
    setField(frame, name, getField(frame, name) | (1 << bit));
}

function clearSegments(frame) {
    for (const n of SEGMENT_FIELDS) setField(frame, n, 0);
}

function allSegments(frame) {
    for (const n of SEGMENT_FIELDS) setField(frame, n, (1 << FIELDS[n][1]) - 1);
}

// Digit positions left to right: main 9..1, then the S-meter's 3..1.
const DIGITS = [
    ...Array.from({ length: MAIN_DIGITS }, (_, i) => ['main', MAIN_DIGITS - i]),
    ...Array.from({ length: SMETER_DIGITS }, (_, i) => ['smeter', SMETER_DIGITS - i]),
];

function hsv(h, s, v) {
    const k = (n) => (n + h / 60) % 6;
    const c = (n) => v - v * s * Math.max(0, Math.min(k(n), 4 - k(n), 1));
    return [c(5), c(3), c(1)].map((x) => Math.round(x * 255));
}

function rainbow(t) {
    return hsv(((t / RAINBOW_MS) * 360) % 360, 1, 1);
}

function backlight(t, target) {
    if (t >= CHASE_END && t < FULL_END) return [255, 255, 255];
    if (t < EASE_FROM) return rainbow(t);
    if (t >= EASE_TO) return target;
    const k = (t - EASE_FROM) / (EASE_TO - EASE_FROM);
    const e = k * k * (3 - 2 * k);
    const from = rainbow(t);
    return from.map((v, i) => Math.round(v + (target[i] - v) * e));
}

function sweep(f, t) {
    const p = t / SWEEP_END;
    const segs = DIGITS.length * DRAW_ORDER.length;
    const n = Math.floor(p * (segs + 1));
    for (let i = 0; i < n && i < segs; i += 1) {
        const [kind, pos] = DIGITS[Math.floor(i / DRAW_ORDER.length)];
        segOn(f, kind, pos, DRAW_ORDER[i % DRAW_ORDER.length]);
    }
    const bars = Math.floor(p * (BAR_FIELDS.length + 1));
    BAR_FIELDS.forEach((name, i) => setField(f, name, i < bars ? 1 : 0));
    const sparks = Math.floor(p * (SPARKLE.length + 1));
    for (let i = 0; i < sparks && i < SPARKLE.length; i += 1) setField(f, SPARKLE[i], 1);
    setField(f, 'usb_led', 1);
}

function chase(f, t) {
    const dt = t - SWEEP_END;
    const step = Math.floor(dt / 70);
    // Each digit a step behind the one to its left, so the spin ripples.
    DIGITS.forEach(([kind, pos], i) => {
        segOn(f, kind, pos, RING[(step + RING.length * 4 - i) % RING.length]);
        segOn(f, kind, pos, RING[(step + RING.length * 4 - i - 1) % RING.length]);
    });
    // The bar: a scanner sweeping end to end and back.
    const span = BAR_FIELDS.length - 1;
    const ph = Math.floor(dt / 30) % (span * 2);
    const at = ph <= span ? ph : span * 2 - ph;
    BAR_FIELDS.forEach((name, i) => setField(f, name, Math.abs(i - at) <= 1 ? 1 : 0));
    // A third of the annunciators at a time, a different third every beat.
    const beat = Math.floor(dt / 140);
    SPARKLE.forEach((name, i) => setField(f, name, (i + beat) % 3 === 0 ? 1 : 0));
    const tick = Math.floor(dt / 200) % 2;
    setField(f, 'usb_led', tick);
    setField(f, 'lock_led', 1 - tick);
}

function name(f, t) {
    const dt = t - FULL_END;
    // Eights, then the letters replacing them left to right.
    const shown = Math.min(MAIN_DIGITS, Math.floor(dt / LETTER_MS) + 1);
    const text = INTRO_TEXT.split('').map((ch, i) => (i < shown ? ch : '8')).join('');
    displayMainText(f, text);
    // The bar drains from full.
    const bars = Math.max(0, BAR_FIELDS.length - Math.floor(dt / DRAIN_MS));
    BAR_FIELDS.forEach((n, i) => setField(f, n, i < bars ? 1 : 0));
    setField(f, 'usb_led', 1);
}

/**
 * The show's frame `t` ms in, over `base`. Past INTRO_MS it is base itself.
 */
export function introFrame(t, base) {
    const f = Uint8Array.from(base);
    if (!(t >= 0) || t >= INTRO_MS) return f;
    const target = ['rgb_red', 'rgb_green', 'rgb_blue'].map((n) => getField(base, n));
    clearSegments(f);
    for (const led of LEDS) setField(f, led, 0);
    if (t < SWEEP_END) sweep(f, t);
    else if (t < CHASE_END) chase(f, t);
    else if (t < FULL_END) {
        allSegments(f);
        for (const led of LEDS) setField(f, led, 1);
    } else name(f, t);
    const [r, g, b] = backlight(t, target);
    setField(f, 'rgb_red', r);
    setField(f, 'rgb_green', g);
    setField(f, 'rgb_blue', b);
    return f;
}
