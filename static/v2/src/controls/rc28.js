// Icom RC-28 — a USB tuning dial with three buttons and four LEDs, read over
// the WebHID API.
//
// Not a serial device like the FlexControl: it is a plain USB HID with no
// driver, so the page reaches it through `navigator.hid`. The protocol is the
// one FlexRC-28 reverse-engineered from a USB capture (github.com/
// CerberusSolutions/FlexRC-28, README "RC-28 HID Protocol"); it is restated
// here because nothing else in this tree describes it.
//
// Input report, 32 bytes, every 10 ms or so while anything moves:
//
//   [0] 0x01            a state report
//   [1] dial counts     how far it turned since the last report, 0 stopped;
//                       about 670 to the turn (sdroxide, below, summed them)
//   [3] direction       0x01 clockwise (up), 0x02 anticlockwise (down)
//   [5] buttons         active low — bit 0 PTT, bit 1 F1, bit 2 F2; 0x07 idle
//
// or, in answer to the firmware query below, [0x02]["102 3210"][0 …].
//
// Output report, 32 bytes: [0x01][leds][0 …] — bit 0 TX, bit 1 F1, bit 2 F2,
// bit 3 Link, also active low, so 0x0F is everything off. [0x02][0 …] asks for
// the firmware version.
//
// All of that is also what sdroxide's RC-28 support reads and writes over
// WebHID (github.com/dividebysandwich/sdroxide, pull 553), checked against a
// real unit in Chrome: no report IDs, and nothing to send before the dial
// starts reporting or the LEDs light.
//
// What the LEDs show is the operator's choice (controls/rc28leds.js); this file
// only drives them — the receiver state from setIndicators(), a held button's
// LED flipped on top, Link blinking when asked.
//
// The buttons report only down and up. Tap and hold are told apart here by how
// long the button was down, at FlexRC-28's 600 ms, and like the FlexControl's
// own hold the hold fires on release. There is no double tap: telling one from
// a single tap means holding every tap back until the window for a second one
// has passed, and a button that answers a few hundred milliseconds late feels
// broken. The FlexControl can afford it because its firmware does the waiting.
//
// PTT is just the third button. This is a receiver; nothing here transmits.

import { Emitter } from '../radio/emitter.js';

// The OS device chooser is filtered to this, so the operator is not asked to
// pick their dial out of every HID device on the machine.
export const RC28_VENDOR_ID = 0x0C26;
export const RC28_PRODUCT_ID = 0x001E;

export const HOLD_MS = 600;

// Half a blink: on this long, off this long.
export const BLINK_MS = 500;

// The dial has no detents, and counts about ten times as finely as one that
// does; ten counts make one, about 67 to the turn, as sdroxide has it.
export const COUNTS_PER_DETENT = 10;

// How often the gathered counts go out as detents. A report every 10 ms would
// be a hundred retunes a second, so they are summed and sent at this pace — and
// summed rather than thinned, so no turn of the dial is lost on the way.
export const DIAL_FLUSH_MS = 50;

// How long a dial that was sent the firmware query has to answer, or send
// anything at all, before the log says it has not been heard from.
export const ANSWER_MS = 2000;

const REPORT_BYTES = 32;

// Button bits in byte 5, and in the LED byte — the hardware puts each button's
// LED on the same bit as the button. Link is the fourth LED and has no button.
const BUTTONS = [
    { bit: 0, name: 'ptt' },
    { bit: 1, name: 'f1' },
    { bit: 2, name: 'f2' },
];
const LED_LINK = 3;
const BUTTONS_IDLE = 0x07;

export const RC28_KEYS = [
    { key: 'dial_down', label: 'Dial — anticlockwise' },
    { key: 'dial_up', label: 'Dial — clockwise' },
    { key: 'ptt_tap', label: 'PTT — tap' },
    { key: 'ptt_hold', label: 'PTT — hold' },
    { key: 'f1_tap', label: 'F1 — tap' },
    { key: 'f1_hold', label: 'F1 — hold' },
    { key: 'f2_tap', label: 'F2 — tap' },
    { key: 'f2_hold', label: 'F2 — hold' },
];

const KEY_LABEL = Object.fromEntries(RC28_KEYS.map((k) => [k.key, k.label]));

export function rc28KeyLabel(key) {
    return KEY_LABEL[key] || key;
}

// The dial comes out of the box mapped to the frequency, so the first thing it
// does when turned is tune — 100 Hz a detent, so about 6.7 kHz a turn. The
// buttons are left for the operator to assign.
//
// No rate limit: the driver paces the dial itself (DIAL_FLUSH_MS), and a limit
// on top would throw away the counts it had gathered.
export const RC28_DIAL_MAPPING = { function: 'freq_enc_100', throttleMs: 0, mode: 'none' };
export const RC28_DEFAULT_MAPPINGS = {
    dial_up: RC28_DIAL_MAPPING,
    dial_down: RC28_DIAL_MAPPING,
};

// What the defaults were before the dial was paced here: a 1 kHz encoder behind
// a 100 ms limit, which let one report in ten through. A table still holding
// exactly that is upgraded on load — see mappings.js.
export const RC28_OLD_DIAL_MAPPING = { function: 'freq_enc_1k', throttleMs: 100, mode: 'rate_limit' };

/**
 * One input report as `{ speed, direction, buttons }`, or null for anything
 * that is not one.
 *
 * `bytes` is the report's payload. WebHID hands it over without a report ID
 * when the device does not number its reports, which is what FlexRC-28's
 * capture shows — the 0x01 is then the first payload byte. A descriptor that
 * did declare report ID 1 would take that byte off the front instead, so
 * `reportId` 1 shifts everything one place. Either way the fields read the same.
 */
export function parseReport(bytes, reportId = 0) {
    if (!bytes) return null;
    const off = reportId === 1 ? -1 : 0;
    if (off === 0 && bytes[0] !== 0x01) return null;
    if (bytes.length < 6 + off) return null;
    const speed = bytes[1 + off];
    const dir = bytes[3 + off];
    return {
        speed,
        direction: dir === 0x01 ? 1 : (dir === 0x02 ? -1 : 0),
        // Masked, because the bits above F2 are not buttons and a stray one
        // would read as a button change on every report.
        buttons: bytes[5 + off] & BUTTONS_IDLE,
    };
}

/**
 * The firmware version, if this report is the answer to the query, else null.
 * Text from byte 1 to the first zero; with a numbered report 2 the ID has taken
 * the 0x02 off the front, as parseReport explains.
 */
export function parseFirmware(bytes, reportId = 0) {
    if (!bytes) return null;
    let start;
    if (reportId === 2) start = 0;
    else if (reportId === 0 && bytes[0] === 0x02) start = 1;
    else return null;
    let text = '';
    for (let i = start; i < bytes.length && bytes[i] !== 0; i++) text += String.fromCharCode(bytes[i]);
    return text.trim();
}

/**
 * Whole detents out of `carry` dial counts: `{ detents, carry }`, the remainder
 * carried. Toward zero, so a turn back spends the carry first and a wiggle
 * nets out rather than moving the receiver.
 */
export function takeDetents(carry) {
    const detents = Math.trunc(carry / COUNTS_PER_DETENT) || 0;   // never -0
    return { detents, carry: carry - detents * COUNTS_PER_DETENT };
}

/** The LED byte for a set of lit LEDs. Active low: 0x0F is all off. */
export function ledByte({ link = false, ptt = false, f1 = false, f2 = false } = {}) {
    let b = 0x0F;
    if (ptt) b &= ~(1 << 0);
    if (f1) b &= ~(1 << 1);
    if (f2) b &= ~(1 << 2);
    if (link) b &= ~(1 << LED_LINK);
    return b;
}

export function rc28Available() {
    return typeof navigator !== 'undefined' && !!navigator.hid;
}

export function isRc28(device) {
    return !!device && device.vendorId === RC28_VENDOR_ID && device.productId === RC28_PRODUCT_ID;
}

// The output report IDs the descriptor declares. None — what FlexRC-28 and
// sdroxide write to — is also the answer when the descriptor says nothing.
function outputReportIds(device) {
    const ids = [];
    for (const c of (device && device.collections) || []) {
        for (const r of c.outputReports || []) {
            if (Number.isInteger(r.reportId) && r.reportId) ids.push(r.reportId);
        }
    }
    return ids;
}

export class RC28Control extends Emitter {
    /**
     * `clock` is a seam for the tests: now() and the timer pair, which is all
     * the hold detection needs and all a test needs to replace.
     */
    constructor(clock = {}) {
        super();
        this.device = null;
        this.connected = false;
        this._now = clock.now || (() => Date.now());
        this._setTimeout = clock.setTimeout || ((fn, ms) => setTimeout(fn, ms));
        this._clearTimeout = clock.clearTimeout || ((id) => clearTimeout(id));
        this._buttons = BUTTONS_IDLE;
        this._down = {};        // name -> when it went down
        this._held = {};        // name -> past the hold threshold
        this._timers = {};      // name -> the hold-threshold timer
        // What the LEDs say about the receiver — see rc28leds.js, and
        // ControlWatch, which sets them. Each true, false or 'blink'. Link on
        // and the rest off until told otherwise, so a dial connected before
        // anything has set them still shows that it is.
        this._indicators = { link: true, ptt: false, f1: false, f2: false };
        this._holdFeedback = true;
        this._blinkOn = true;
        this._blinkTimer = null;
        // The LED byte last written. LEDs are set from a poll several times a
        // second; a report goes out only when the byte would change.
        this._lastSent = null;
        // Dial counts not yet sent as detents, and the timer that sends them.
        this._counts = 0;
        this._dialTimer = null;
        // Whether anything has come back from the dial since it was opened, and
        // the timer that says so in the log if nothing has.
        this._heard = false;
        this._answerTimer = null;
        // A failed LED write is said once per connection, not once per write.
        this._writeFailed = false;
        this._onReport = (e) => this._report(e);
        this._onGone = (e) => { if (e.device === this.device) this._lost(); };
    }

    // Must be called from a user gesture — the device chooser is gated on one.
    async connect() {
        if (!rc28Available()) {
            this.emit('message', { text: 'This browser has no WebHID API — try Chrome or Edge.', tone: 'error' });
            return false;
        }
        let devices;
        try {
            devices = await navigator.hid.requestDevice({
                filters: [{ vendorId: RC28_VENDOR_ID, productId: RC28_PRODUCT_ID }],
            });
        } catch (err) {
            this.emit('message', { text: `Could not open the RC-28: ${err.message}`, tone: 'error' });
            return false;
        }
        // An empty list is the chooser being dismissed, which is not a fault.
        const device = (devices || []).find(isRc28);
        if (!device) return false;
        return this._start(device, false);
    }

    // Opens a device the operator has already granted, with no chooser and so
    // no gesture. `getDevices()` returns only what this origin was granted, and
    // only an RC-28 is taken from it. Every way of having no dial is the same
    // quiet false — see FlexControl.autoConnect, which this follows.
    async autoConnect() {
        if (!rc28Available() || this.connected) return false;
        let devices;
        try {
            devices = await navigator.hid.getDevices();
        } catch (err) {
            return false;
        }
        const device = (devices || []).find(isRc28);
        if (!device) return false;
        return this._start(device, true);
    }

    async _start(device, quiet) {
        try {
            // A device this page opened before and never closed is still open.
            if (!device.opened) await device.open();
        } catch (err) {
            if (!quiet) this.emit('message', { text: `Could not open the RC-28: ${err.message}`, tone: 'error' });
            return false;
        }

        this.device = device;
        const ids = outputReportIds(device);
        this._outId = ids.length ? ids[0] : 0;
        // With numbered reports the query goes out as report 2, so only if the
        // descriptor has one; without, it is just a payload starting 0x02.
        this._canQuery = !ids.length || ids.includes(2);
        this._buttons = BUTTONS_IDLE;
        this._counts = 0;
        this._heard = false;
        this._writeFailed = false;
        this.connected = true;
        device.addEventListener('inputreport', this._onReport);
        if (navigator.hid.addEventListener) navigator.hid.addEventListener('disconnect', this._onGone);
        this.emit('state', { connected: true });
        this.emit('message', { text: 'RC-28 connected', tone: 'good' });
        this._lastSent = null;
        this._leds();
        this._blink();
        this._query();
        return true;
    }

    // Asks the dial for its firmware version. The answer is logged, and is the
    // proof that the page and the dial are talking both ways — a dial that
    // stays dark and ignores the knob otherwise looks exactly like one that
    // was never connected.
    _query() {
        if (!this._canQuery) return;
        this._write(0x02, 0);
        this._answerTimer = this._setTimeout(() => {
            this._answerTimer = null;
            if (this._heard || !this.connected) return;
            this.emit('message', {
                text: 'The RC-28 is open but has not answered. Unplug it and plug it back in, '
                    + 'and close anything else that may be using it.',
                tone: 'warn',
            });
        }, ANSWER_MS);
    }

    // The LEDs go dark first: a dial left showing Link after the page has let
    // go of it says it is still driving the receiver.
    async disconnect() {
        const device = this.device;
        if (!device) return;
        this._clearHolds();
        this._stopBlink();
        await this._send(ledByte());
        this._lastSent = null;
        this._detach();
        try { await device.close(); } catch (e) { /* already gone */ }
        this.emit('state', { connected: false });
        this.emit('message', { text: 'Disconnected', tone: 'info' });
    }

    _lost() {
        this._clearHolds();
        this._stopBlink();
        this._lastSent = null;
        this._detach();
        this.emit('state', { connected: false });
        this.emit('message', { text: 'RC-28 disconnected', tone: 'warn' });
    }

    _detach() {
        if (this.device) this.device.removeEventListener('inputreport', this._onReport);
        if (rc28Available() && navigator.hid.removeEventListener) {
            navigator.hid.removeEventListener('disconnect', this._onGone);
        }
        this.device = null;
        this.connected = false;
    }

    _clearHolds() {
        for (const id of Object.values(this._timers)) this._clearTimeout(id);
        this._timers = {};
        this._down = {};
        this._held = {};
        this._buttons = BUTTONS_IDLE;
        if (this._dialTimer !== null) this._clearTimeout(this._dialTimer);
        this._dialTimer = null;
        this._counts = 0;
        if (this._answerTimer !== null) this._clearTimeout(this._answerTimer);
        this._answerTimer = null;
    }

    // --- input -------------------------------------------------------------

    _report(e) {
        const view = e.data;
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        this._heard = true;
        if (this._answerTimer !== null) {
            this._clearTimeout(this._answerTimer);
            this._answerTimer = null;
        }
        const firmware = parseFirmware(bytes, e.reportId);
        if (firmware !== null) {
            this.emit('message', { text: `RC-28 firmware ${firmware || '(blank)'}`, tone: 'info' });
            return;
        }
        const r = parseReport(bytes, e.reportId);
        if (!r) return;

        if (r.speed && r.direction) {
            this._counts += r.speed * r.direction;
            if (this._dialTimer === null) {
                this._dialTimer = this._setTimeout(() => this._flushDial(), DIAL_FLUSH_MS);
            }
        }
        if (r.buttons !== this._buttons) {
            const was = this._buttons;
            this._buttons = r.buttons;
            this._buttonsChanged(was, r.buttons);
        }
    }

    _flushDial() {
        this._dialTimer = null;
        const { detents, carry } = takeDetents(this._counts);
        this._counts = carry;
        if (!detents) return;
        this.emit('input', {
            key: detents > 0 ? 'dial_up' : 'dial_down',
            event: { kind: 'relative', delta: detents },
        });
    }

    _buttonsChanged(was, now) {
        for (const { bit, name } of BUTTONS) {
            const wasDown = (was & (1 << bit)) === 0;
            const isDown = (now & (1 << bit)) === 0;
            if (!wasDown && isDown) this._press(name);
            else if (wasDown && !isDown) this._release(name);
        }
    }

    // The button's own LED flips once it has been down long enough to count as
    // a hold — on if it was off, off if it was showing something — so the
    // operator can see the moment a release changes from a tap to a hold,
    // which they otherwise cannot, because the hold fires on release.
    _press(name) {
        this._down[name] = this._now();
        this._timers[name] = this._setTimeout(() => {
            delete this._timers[name];
            this._held[name] = true;
            this._leds();
        }, HOLD_MS);
    }

    _release(name) {
        const since = this._down[name];
        delete this._down[name];
        if (this._timers[name] !== undefined) {
            this._clearTimeout(this._timers[name]);
            delete this._timers[name];
        }
        const wasLit = !!this._held[name];
        delete this._held[name];
        if (wasLit) this._leds();
        if (since === undefined) return;
        // Measured, not taken from the timer: a page busy enough to run the
        // timer late must still call a 700 ms press a hold.
        const hold = this._now() - since >= HOLD_MS;
        this.emit('input', { key: `${name}_${hold ? 'hold' : 'tap'}`, event: { kind: 'trigger' } });
    }

    // --- output ------------------------------------------------------------

    /**
     * What the LEDs say about the receiver: any of `link`, `ptt`, `f1`, `f2`,
     * each true, false or 'blink'. Merged, so a caller sets only what it owns.
     */
    setIndicators(next) {
        const merged = { ...this._indicators };
        for (const k of ['link', 'ptt', 'f1', 'f2']) {
            if (next && k in next) merged[k] = next[k] === 'blink' ? 'blink' : !!next[k];
        }
        this._indicators = merged;
        this._leds();
        this._blink();
    }

    /** Whether a button's LED flips when a press becomes a hold. */
    setHoldFeedback(on) {
        this._holdFeedback = !!on;
        this._leds();
    }

    // The byte for now: each indicator, a blinking one at its current phase,
    // and a held button's LED flipped from whatever that gives.
    _ledByte() {
        const shown = (v) => (v === 'blink' ? this._blinkOn : !!v);
        const lit = { link: shown(this._indicators.link) };
        for (const { name } of BUTTONS) {
            lit[name] = shown(this._indicators[name]);
            if (this._holdFeedback && this._held[name]) lit[name] = !lit[name];
        }
        return ledByte(lit);
    }

    _leds() {
        if (!this.connected) return;
        const b = this._ledByte();
        if (b === this._lastSent) return;
        this._lastSent = b;
        this._send(b);
    }

    // One timer for every blinking LED, so they blink together, and none at
    // all while nothing blinks. A blinking LED that is set steady again stops
    // on its next phase rather than at once, which nobody can see.
    _blink() {
        const any = Object.values(this._indicators).some((v) => v === 'blink');
        if (!this.connected || !any) { this._stopBlink(); return; }
        if (this._blinkTimer !== null) return;
        const tick = () => {
            this._blinkTimer = null;
            this._blinkOn = !this._blinkOn;
            this._leds();
            this._blink();
        };
        this._blinkTimer = this._setTimeout(tick, BLINK_MS);
    }

    _stopBlink() {
        if (this._blinkTimer !== null) this._clearTimeout(this._blinkTimer);
        this._blinkTimer = null;
        this._blinkOn = true;
    }

    _send(leds) {
        return this._write(0x01, leds);
    }

    // One output report: `cmd` 0x01 for the LEDs, 0x02 for the firmware query.
    // With no report ID the command is the payload's first byte, as FlexRC-28
    // writes it; with one, the ID stands in its place.
    async _write(cmd, arg) {
        const device = this.device;
        if (!device || !device.sendReport) return;
        const report = new Uint8Array(REPORT_BYTES);
        let id = 0;
        let data = report;
        if (this._outId) {
            id = cmd === 0x01 ? this._outId : cmd;
            report[0] = arg;
            data = report.subarray(0, REPORT_BYTES - 1);
        } else {
            report[0] = cmd;
            report[1] = arg;
        }
        try {
            await device.sendReport(id, data);
        } catch (err) {
            // Said once: a dial whose LEDs never light is otherwise
            // indistinguishable from one that was never connected.
            if (this._writeFailed || device !== this.device) return;
            this._writeFailed = true;
            this.emit('message', { text: `Could not write to the RC-28: ${err.message}`, tone: 'warn' });
        }
    }
}
