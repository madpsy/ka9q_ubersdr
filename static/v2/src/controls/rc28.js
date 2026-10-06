// Icom RC-28 — a USB tuning dial with three buttons and four LEDs, read over
// the WebHID API.
//
// Not a serial device like the FlexControl: it is a plain USB HID with no
// driver, so the page reaches it through `navigator.hid`. The protocol is the
// one FlexRC-28 reverse-engineered from a USB capture (github.com/
// CerberusSolutions/FlexRC-28, README "RC-28 HID Protocol"); it is restated
// here because nothing else in this tree describes it.
//
// Input report, 32 bytes, sent while anything moves:
//
//   [0] 0x01            always
//   [1] dial speed      0 stopped, 1–16 or so the faster it spins
//   [3] direction       0x01 clockwise (up), 0x02 anticlockwise (down)
//   [5] buttons         active low — bit 0 PTT, bit 1 F1, bit 2 F2; 0x07 idle
//
// Output report, 32 bytes: [0x01][leds][0 …] — bit 0 TX, bit 1 F1, bit 2 F2,
// bit 3 Link, also active low, so 0x0F is everything off.
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
// does when turned is tune. The buttons are left for the operator to assign.
export const RC28_DEFAULT_MAPPINGS = {
    dial_up: { function: 'freq_enc_1k', throttleMs: 100, mode: 'rate_limit' },
    dial_down: { function: 'freq_enc_1k', throttleMs: 100, mode: 'rate_limit' },
};

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
 * Detents for one dial report: signed, 1–6 in magnitude.
 *
 * The catalogue's encoders multiply their step by the delta, and that scale was
 * set by the FlexControl, whose speeds run 1–6. The RC-28 reports up to about
 * 16, and handed through raw a quick flick of the wrist would move a 1 kHz
 * encoder 16 kHz at a time. So the speed is folded onto the same 1–6, along the
 * bands FlexRC-28's own velocity curve uses — slow turns stay one detent each,
 * and only a real spin accelerates.
 */
export function dialDelta(speed, direction) {
    if (!speed || !direction) return 0;
    let mag;
    if (speed <= 2) mag = 1;
    else if (speed <= 4) mag = 2;
    else if (speed <= 7) mag = 3;
    else if (speed <= 11) mag = 4;
    else if (speed <= 15) mag = 5;
    else mag = 6;
    return direction * mag;
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

// The output report's ID, read off the descriptor rather than assumed. 0 — no
// ID — is what FlexRC-28 writes, and it is also the answer when the descriptor
// says nothing.
function outputReportId(device) {
    for (const c of (device && device.collections) || []) {
        for (const r of c.outputReports || []) {
            if (Number.isInteger(r.reportId)) return r.reportId;
        }
    }
    return 0;
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
        this._outId = outputReportId(device);
        this._buttons = BUTTONS_IDLE;
        this.connected = true;
        device.addEventListener('inputreport', this._onReport);
        if (navigator.hid.addEventListener) navigator.hid.addEventListener('disconnect', this._onGone);
        this.emit('state', { connected: true });
        this.emit('message', { text: 'RC-28 connected', tone: 'good' });
        this._lastSent = null;
        this._leds();
        this._blink();
        return true;
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
    }

    // --- input -------------------------------------------------------------

    _report(e) {
        const view = e.data;
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        const r = parseReport(bytes, e.reportId);
        if (!r) return;

        const delta = dialDelta(r.speed, r.direction);
        if (delta) {
            this.emit('input', {
                key: delta > 0 ? 'dial_up' : 'dial_down',
                event: { kind: 'relative', delta },
            });
        }
        if (r.buttons !== this._buttons) {
            const was = this._buttons;
            this._buttons = r.buttons;
            this._buttonsChanged(was, r.buttons);
        }
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

    async _send(leds) {
        const device = this.device;
        if (!device || !device.sendReport) return;
        const report = new Uint8Array(REPORT_BYTES);
        // With no report ID the 0x01 is part of the payload, as FlexRC-28
        // writes it; with one, the ID stands in its place.
        if (this._outId) {
            report[0] = leds;
            try { await device.sendReport(this._outId, report.subarray(0, REPORT_BYTES - 1)); } catch (e) { /* cosmetic */ }
            return;
        }
        report[0] = 0x01;
        report[1] = leds;
        // A lamp that would not light is not worth a line in the log: the dial
        // still works, and that is the part the operator came for.
        try { await device.sendReport(0, report); } catch (e) { /* cosmetic */ }
    }
}
