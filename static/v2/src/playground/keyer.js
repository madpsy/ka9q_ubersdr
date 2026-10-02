// A Morse keyer: text in, a keyed tone out, as it arrives.
//
// The Morse encoder block's engine (blocks/digital.js). Text is queued and
// sent a character at a time from the same table the decoder reads
// (codes.js MORSE), so whatever one sends the other can copy. Timing is
// PARIS: a dit is 1.2 / wpm seconds, a dah three, one dit between the parts
// of a character, three between characters and seven between words.
//
// The speed is read afresh at the start of every dit, dah and gap, so a
// speed that changes — a slider moved, or a decoder's estimate of the sender
// it is copying — changes the keying from the next element on, not from the
// next message.
//
// Farnsworth: the characters at the speed set, the gaps between them
// stretched so the whole goes at the slower effective speed — the ARRL's
// formula, the usual way of learning to copy at speed.
//
// Keying is shaped: the key level ramps over the rise time on a raised
// cosine either end, so the tone starts and stops without the click a square
// key puts on the band — or in the ear.

import { MORSE } from './codes.js';

export const KEYER_DEFAULTS = { wpm: 20, pitchHz: 700, levelDb: -12, riseMs: 5, farnsworthWpm: 0 };
export const WPM_MIN = 5;
export const WPM_MAX = 60;
// The most text waiting to be sent: beyond it, the oldest goes.
export const MAX_QUEUE = 500;

/** What a character is sent as: its marks and spaces in units, or null. */
export function elementsOf(ch) {
    const p = MORSE[ch];
    if (!p) return null;
    const out = [];
    [...p].forEach((e, i) => {
        if (i) out.push([false, 1]);
        out.push([true, e === '.' ? 1 : 3]);
    });
    return out;
}

/**
 * The gaps between characters and between words, in seconds, at `wpm` with
 * Farnsworth spacing for `effective` (0 or not slower: none).
 */
export function morseGaps(wpm, effective) {
    const dit = 1.2 / wpm;
    if (!(effective > 0) || effective >= wpm) return { char: 3 * dit, word: 7 * dit };
    // The ARRL's: the time a word's worth of spacing takes at the effective
    // speed, shared out 3 : 7.
    const ta = (60 * wpm - 37.2 * effective) / (wpm * effective);
    return { char: (3 * ta) / 19, word: (7 * ta) / 19 };
}

export class Keyer {
    constructor() {
        this.p = { ...KEYER_DEFAULTS };
        this.rate = 12000;
        this.text = '';          // waiting to be sent
        this.elements = [];      // the character being sent: [on, units | seconds-gap]
        this.on = false;         // the key, now
        this.left = 0;           // samples left of the current element
        this.ramp = 0;           // where the key's edge is, 0 … 1
        this.phase = 0;
        this.sending = '';       // the character being sent
        this.dropped = 0;        // characters let go when too far behind
        this.sent = '';          // characters finished since last asked
        this.wordGap = false;    // whether the next gap is a word's
        this.shortGap = false;   // the last gap was a character's, not a word's
    }

    configure(p, rate) {
        this.p = { ...this.p, ...p };
        this.rate = rate > 0 ? rate : 12000;
    }

    reset() {
        this.text = '';
        this.elements = [];
        this.on = false;
        this.left = 0;
        this.ramp = 0;
        this.phase = 0;
        this.sending = '';
        this.sent = '';
        this.shortGap = false;
    }

    /** More to send. Unknown characters are left out; line ends are spaces. */
    queue(text) {
        const clean = String(text || '').toUpperCase().replace(/[\r\n\t]/g, ' ');
        let add = '';
        for (const ch of clean) if (ch === ' ' || MORSE[ch]) add += ch;
        if (!add) return;
        this.text += add;
        if (this.text.length > MAX_QUEUE) {
            const over = this.text.length - MAX_QUEUE;
            this.dropped += over;
            this.text = this.text.slice(over);
        }
    }

    /** The speed in force: `wpm` if given — a control input — or the setting. */
    _wpm(override) {
        const w = Number(override) > 0 ? Number(override) : this.p.wpm;
        return Math.max(WPM_MIN, Math.min(WPM_MAX, w));
    }

    /**
     * The next element, or false for nothing to send. Each is `{ on, units }`
     * — a mark, or the gap inside a character, timed by the dit at the speed
     * now — or `{ on: false, sec }`, the gap after a character, timed already
     * so Farnsworth can stretch it.
     */
    _next(wpm) {
        const dit = 1.2 / wpm;
        for (;;) {
            if (this.elements.length) {
                const e = this.elements.shift();
                this.on = e.on;
                this.left = Math.max(1, Math.round((e.sec != null ? e.sec : e.units * dit) * this.rate));
                if (e.sec != null && this.sending) {
                    // The character is out once the gap after it has begun.
                    this.sent += this.sending + (this.wordGap ? ' ' : '');
                    this.sending = '';
                }
                return true;
            }
            if (!this.text.length) return false;
            const ch = this.text[0];
            this.text = this.text.slice(1);
            const g = morseGaps(wpm, this.p.farnsworthWpm);
            if (ch === ' ') {
                // A space that came after its word had gone with a
                // character's gap: the rest of a word's. Spaces after that
                // run together into the one gap.
                if (this.shortGap) {
                    this.shortGap = false;
                    this.sent += ' ';
                    this.elements = [{ on: false, sec: Math.max(0, g.word - g.char) }];
                }
                continue;
            }
            const el = elementsOf(ch);
            if (!el) continue;
            this.sending = ch;
            this.wordGap = this.text.startsWith(' ');
            this.shortGap = !this.wordGap;
            this.elements = [
                ...el.map(([on, units]) => ({ on, units })),
                { on: false, sec: this.wordGap ? g.word : g.char },
            ];
        }
    }

    /**
     * `n` samples of tone into `out`, and the key level into `key` if given.
     * `wpm` overrides the speed setting while it is a number above zero.
     */
    process(out, n, wpm = null, key = null) {
        const rate = this.rate;
        const amp = Math.pow(10, (Number(this.p.levelDb) || 0) / 20);
        const step = (2 * Math.PI * Math.min(this.p.pitchHz, rate * 0.45)) / rate;
        const rise = Math.max(1, Math.round((Math.max(0.5, this.p.riseMs) / 1000) * rate));
        const dRamp = 1 / rise;
        let { phase, ramp } = this;
        for (let k = 0; k < n; k++) {
            if (this.left <= 0) {
                if (!this._next(this._wpm(wpm))) {
                    this.on = false;
                    this.left = 0;
                }
            }
            if (this.left > 0) this.left--;
            // The key's edge, toward where it should be, one step a sample.
            if (this.on) ramp = ramp + dRamp > 1 ? 1 : ramp + dRamp;
            else ramp = ramp - dRamp < 0 ? 0 : ramp - dRamp;
            const shaped = Math.sin((Math.PI / 2) * ramp) ** 2;
            out[k] = shaped ? amp * shaped * Math.sin(phase) : 0;
            if (key) key[k] = shaped;
            phase += step;
            if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
        }
        this.phase = phase;
        this.ramp = ramp;
    }

    /** Characters finished since the last call. */
    takeSent() {
        const s = this.sent;
        this.sent = '';
        return s;
    }

    /** For the card: what is being sent, how much is waiting, how much was let go. */
    state(wpm = null) {
        return { sending: this.sending, waiting: this.text.replace(/ /g, '').length, dropped: this.dropped, wpm: this._wpm(wpm) };
    }
}
