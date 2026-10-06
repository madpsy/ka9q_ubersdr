// What the RC-28's LEDs show, as settings the operator chooses.
//
// Four LEDs, and each can say something about the receiver. None of them is
// forced on anybody — a lamp that means something to one operator is noise to
// another — so each is a switch in SDR Control:
//
//   Link    lit while the dial is connected; optionally blinking while the
//           receiver's audio stream is down, so a dead receiver is visible
//           from the desk rather than only on screen
//   F1, F2  optionally lit while whatever the button is mapped to is on — the
//           tuning lock, mute, NR, a mode. See `lit` in functions.js
//   TX      off, or one of: what the PTT button is mapped to, the squelch
//           passing a signal, or a recording running
//
// Separately, a button's own LED flips for as long as a press has gone on long
// enough to count as a hold. That is the driver's (rc28.js) — it knows when a
// button went down — and it is a switch here too.
//
// This file only decides. It is a pure function of the settings and of what
// the receiver is doing, so it is tested without a page, and ControlWatch is
// what feeds it and hands the answer to the driver.

import { functionLit } from './functions.js';

export const TX_LED_SOURCES = [
    { value: 'off', label: 'Off' },
    { value: 'mapping', label: 'What PTT controls' },
    { value: 'squelch', label: 'Signal above the squelch' },
    { value: 'recording', label: 'Recording' },
];

export const DEFAULT_LEDS = {
    // The three that cost nothing to have on: each is quiet unless something
    // is happening that the operator would want to know about.
    hold: true,
    follow: true,
    linkBlink: true,
    // Off, because there is more than one thing it could mean.
    tx: 'off',
};

/** The settings with every gap filled, so a partial or older blob still works. */
export function ledSettings(raw) {
    const s = { ...DEFAULT_LEDS, ...(raw && typeof raw === 'object' ? raw : {}) };
    if (!TX_LED_SOURCES.some((o) => o.value === s.tx)) s.tx = DEFAULT_LEDS.tx;
    s.hold = !!s.hold;
    s.follow = !!s.follow;
    s.linkBlink = !!s.linkBlink;
    return s;
}

// Whether a button's LED should be lit for its mapping. The tap is asked first,
// because that is what a button is usually for; a hold mapping is the fallback
// for a button with nothing on its tap, or nothing on its tap that has an on.
function buttonLit(name, mappings, ctx) {
    for (const key of [`${name}_tap`, `${name}_hold`]) {
        const m = mappings && mappings[key];
        if (!m) continue;
        const lit = functionLit(m.function, ctx);
        if (lit !== null) return lit;
    }
    return false;
}

/**
 * The indicator LEDs, as `{ link, ptt, f1, f2 }` — each true, false or 'blink'.
 *
 *   settings     ledSettings(...)
 *   mappings     the RC-28's mapping table
 *   ctx          the radio facade (useControlContext)
 *   receiverUp   whether the receiver's audio stream is open
 *   squelchOpen  whether the squelch is passing a signal right now
 *   recording    whether a recording is running
 */
export function indicatorLeds({ settings, mappings, ctx, receiverUp, squelchOpen, recording }) {
    const s = ledSettings(settings);
    const out = {
        link: s.linkBlink && !receiverUp ? 'blink' : true,
        ptt: false,
        f1: false,
        f2: false,
    };
    if (ctx && s.follow) {
        out.f1 = buttonLit('f1', mappings, ctx);
        out.f2 = buttonLit('f2', mappings, ctx);
    }
    if (s.tx === 'mapping' && ctx) out.ptt = buttonLit('ptt', mappings, ctx);
    else if (s.tx === 'squelch') out.ptt = !!squelchOpen;
    else if (s.tx === 'recording') out.ptt = !!recording;
    return out;
}
