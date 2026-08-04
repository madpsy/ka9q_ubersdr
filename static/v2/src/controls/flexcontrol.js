// FlexRadio Systems FlexControl — a USB dial, read over the Web Serial API.
//
// 9600 8N1, no line endings: the device emits semicolon-delimited tokens as
// fast as you turn it.
//
//   dial anticlockwise  D  D02 D03 D04 D05 D06   (the number is speed, 1–6)
//   dial clockwise      U  U02 U03 U04 U05 U06
//   AUX n tap/double/hold   XnS / XnC / XnL      (hold fires on release)
//   reset on plug-in    F0304                    (ignored)
//
// e.g. `D;D;D;U;U02;U03;U04;U03;U05;`
//
// The dial's speed byte is carried through as the event's `delta`, so a fast
// spin moves further per detent — the acceleration is in the hardware and the
// function catalogue just multiplies by it.

import { Emitter } from '../radio/emitter.js';

// The OS port picker is filtered to this device, so the operator is not asked
// to pick their FlexControl out of a list of every serial adapter they own.
const USB_VENDOR_ID = 0x2192;
const USB_PRODUCT_ID = 0x0010;

export const FLEX_KEYS = [
    { key: 'dial_down', label: 'Dial — anticlockwise' },
    { key: 'dial_up', label: 'Dial — clockwise' },
    { key: 'aux1_tap', label: 'AUX 1 — tap' },
    { key: 'aux1_dbl', label: 'AUX 1 — double tap' },
    { key: 'aux1_hold', label: 'AUX 1 — hold' },
    { key: 'aux2_tap', label: 'AUX 2 — tap' },
    { key: 'aux2_dbl', label: 'AUX 2 — double tap' },
    { key: 'aux2_hold', label: 'AUX 2 — hold' },
    { key: 'aux3_tap', label: 'AUX 3 — tap' },
    { key: 'aux3_dbl', label: 'AUX 3 — double tap' },
    { key: 'aux3_hold', label: 'AUX 3 — hold' },
];

const KEY_LABEL = Object.fromEntries(FLEX_KEYS.map((k) => [k.key, k.label]));

export function flexKeyLabel(key) {
    return KEY_LABEL[key] || key;
}

const AUX = {
    X1S: 'aux1_tap', X1C: 'aux1_dbl', X1L: 'aux1_hold',
    X2S: 'aux2_tap', X2C: 'aux2_dbl', X2L: 'aux2_hold',
    X3S: 'aux3_tap', X3C: 'aux3_dbl', X3L: 'aux3_hold',
};

// Returns { key, delta } — delta signed, magnitude 1–6 — or null for a token
// this build ignores.
export function parseToken(token) {
    if (!token) return null;
    if (token === 'D') return { key: 'dial_down', delta: -1 };
    if (token === 'U') return { key: 'dial_up', delta: 1 };
    if (/^D0[1-9]$/.test(token)) return { key: 'dial_down', delta: -parseInt(token.slice(1), 10) };
    if (/^U0[1-9]$/.test(token)) return { key: 'dial_up', delta: parseInt(token.slice(1), 10) };
    if (AUX[token]) return { key: AUX[token], delta: 1 };
    return null;   // F0304 reset, and anything a future firmware adds
}

export function flexAvailable() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
}

export class FlexControl extends Emitter {
    constructor() {
        super();
        this.port = null;
        this.reader = null;
        this.running = false;
        this.connected = false;
    }

    // Must be called from a user gesture — the port picker is gated on one.
    async connect() {
        if (!flexAvailable()) {
            this.emit('message', { text: 'This browser has no Web Serial API — try Chrome or Edge.', tone: 'error' });
            return false;
        }
        let port;
        try {
            port = await navigator.serial.requestPort({
                filters: [{ usbVendorId: USB_VENDOR_ID, usbProductId: USB_PRODUCT_ID }],
            });
        } catch (err) {
            // NotFoundError is the picker being dismissed, which is not a fault.
            if (err && err.name !== 'NotFoundError') {
                this.emit('message', { text: `Could not open the port: ${err.message}`, tone: 'error' });
            }
            return false;
        }
        return this._start(port, false);
    }

    // Opens a port the operator has already granted, with no picker and so no
    // gesture. `getPorts()` returns only ports granted to this origin, and this
    // origin asks for nothing but a FlexControl, so this can never claim a
    // device that was not chosen by hand at least once.
    //
    // Every way of having no dial — permission never given, cable pulled,
    // another tab holding the port — lands in the same place: false, quietly.
    // Autoconnect runs on page load and on hotplug, where a red banner for a
    // dial the operator has not plugged in would be noise, not news.
    async autoConnect() {
        if (!flexAvailable() || this.connected) return false;
        let ports;
        try {
            ports = await navigator.serial.getPorts();
        } catch (err) {
            return false;
        }
        const port = (ports || []).find((p) => {
            const info = (p.getInfo && p.getInfo()) || {};
            return info.usbVendorId === USB_VENDOR_ID && info.usbProductId === USB_PRODUCT_ID;
        });
        if (!port) return false;
        return this._start(port, true);
    }

    // `quiet` suppresses the failure message, not the success one: a dial that
    // does connect on its own should still say so, or the log claims nothing
    // happened while the receiver is taking orders from the desk.
    async _start(port, quiet) {
        try {
            await port.open({ baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1 });
        } catch (err) {
            if (!quiet) this.emit('message', { text: `Could not open the port: ${err.message}`, tone: 'error' });
            return false;
        }

        this.port = port;
        this.connected = true;
        this.running = true;
        this.emit('state', { connected: true });
        this.emit('message', { text: 'FlexControl connected', tone: 'good' });

        this._read().catch((err) => {
            if (!this.running) return;
            this.emit('message', { text: `Read error: ${err.message}`, tone: 'error' });
            this._lost();
        });
        return true;
    }

    // Always releases the reader before closing: a port left with a locked
    // stream cannot be reopened, and the next Connect fails with the device
    // apparently missing.
    async disconnect() {
        this.running = false;
        if (this.reader) {
            try { await this.reader.cancel(); } catch (e) { /* already gone */ }
            this.reader = null;
        }
        if (this.port) {
            try { await this.port.close(); } catch (e) { /* already gone */ }
            this.port = null;
        }
        if (this.connected) {
            this.connected = false;
            this.emit('state', { connected: false });
            this.emit('message', { text: 'Disconnected', tone: 'info' });
        }
    }

    _lost() {
        this.running = false;
        this.reader = null;
        this.port = null;
        this.connected = false;
        this.emit('state', { connected: false });
        this.emit('message', { text: 'FlexControl disconnected', tone: 'warn' });
    }

    async _read() {
        const decoder = new TextDecoder();
        let buffer = '';

        while (this.port && this.port.readable && this.running) {
            this.reader = this.port.readable.getReader();
            try {
                while (this.running) {
                    const { value, done } = await this.reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });

                    let i;
                    while ((i = buffer.indexOf(';')) !== -1) {
                        const token = buffer.slice(0, i).trim();
                        buffer = buffer.slice(i + 1);
                        if (!token) continue;
                        const parsed = parseToken(token);
                        if (!parsed) continue;
                        // Buttons are momentary, the dial is an encoder — the
                        // catalogue reads both off `kind`.
                        this.emit('input', {
                            key: parsed.key,
                            event: parsed.key.startsWith('dial')
                                ? { kind: 'relative', delta: parsed.delta }
                                : { kind: 'trigger' },
                        });
                    }
                }
            } finally {
                if (this.reader) {
                    this.reader.releaseLock();
                    this.reader = null;
                }
            }
        }
    }
}
