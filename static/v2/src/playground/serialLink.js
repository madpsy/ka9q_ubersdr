// A Serial port block's port: the page's half (blocks/serial.js is the graph's).
//
// Web Serial is Chromium's alone — Chrome, Edge, Opera, and the desktop app,
// which is Chromium too — and only on a secure page: https, or the desktop
// app's loopback. Everywhere else `navigator.serial` is not there at all, and a
// link says why and does nothing else: the block it belongs to runs as if its
// port were quiet. serialSupport() is the one place that is decided.
//
// ── What it does ────────────────────────────────────────────────────────────
//
//   open    a port the operator picks (requestPort — it has to be from a
//           press), or the one this block had last time in this browser
//           (getPorts — no picker, but still only from a press: nothing here
//           ever opens a port by itself, so a graph arriving in a link cannot
//           start switching somebody's transmitter)
//   read    bytes in, decoded as the block's encoding, waiting for the next
//           packet to be handed to the graph (takeInbound)
//   write   what the graph handed on, encoded the same way, one write after
//           another in order
//   lines   DTR and RTS set as the graph says (deliver): from the settings,
//           or from the key input at the moment in the packet it changed,
//           played out against a clock of its own so a burst of packets from
//           the worker does not arrive as a burst of key changes
//   poll    CTS, DSR, DCD and RI read every few milliseconds, each change
//           stamped, so it lands at the right point in the next packet
//
// DTR and RTS are dropped whenever there is nothing deciding them — the graph
// stopped, the port closed, the page going away — because one of them may be a
// transmitter's PTT.

import { Emitter } from '../radio/emitter.js';

// Where this browser remembers which port each block had: a USB vendor and
// product, which is what getPorts() can be matched against. Not in the graph:
// a port is a fact about this machine, and a shared graph names none.
export const SERIAL_MEMORY_KEY = 'ubersdr.v2.playground.serial';

// How often the input lines are read while something listens to them, and
// otherwise (for the card).
const POLL_FAST_MS = 4;
const POLL_SLOW_MS = 100;
// How far behind a packet's key changes are played out: enough to absorb the
// worker answering a few packets at once, little enough to key by.
const KEY_DELAY_MS = 40;
// Most received text held for the graph, and most queued to send.
const RX_HOLD_CHARS = 256 * 1024;
const TX_HOLD_BYTES = 256 * 1024;

/**
 * Whether this page can use serial ports, and if not why — in words for the
 * card. `nav` and `secure` are parameters for the tests.
 */
export function serialSupport(
    nav = typeof navigator === 'undefined' ? null : navigator,
    secure = typeof isSecureContext === 'undefined' ? true : isSecureContext,
    app = typeof window !== 'undefined' && !!window.ubersdrDesktop,
) {
    if (nav && nav.serial) return { ok: true, why: '' };
    // Inside one of the apps and still none: the phone and tablet ones, whose
    // web views have no Web Serial (the desktop app's has).
    if (app) return { ok: false, why: 'The phone and tablet apps have no serial ports. They work in the UberSDR desktop app, and in Chrome or Edge on a computer.' };
    const chromium = !!(nav && nav.userAgentData && Array.isArray(nav.userAgentData.brands)
        && nav.userAgentData.brands.some((b) => /Chromium|Chrome|Edge/.test(b.brand)));
    if (!secure) {
        return {
            ok: false,
            why: chromium
                ? 'Serial ports need this receiver to be opened over https.'
                : 'Serial ports need Chrome or Edge on a computer, with the receiver opened over https — or the UberSDR desktop app.',
        };
    }
    return { ok: false, why: 'This browser has no serial ports. They work in Chrome or Edge on a computer, and in the UberSDR desktop app.' };
}

/** The settings a port is opened with, from a block's parameters. */
export function portOptions(p) {
    const baud = p.baud === 'custom' ? Math.round(Number(p.customBaud) || 9600) : Number(p.baud) || 9600;
    return {
        baudRate: Math.max(50, baud),
        dataBits: Number(p.dataBits) === 7 ? 7 : 8,
        parity: ['even', 'odd'].includes(p.parity) ? p.parity : 'none',
        stopBits: Number(p.stopBits) === 2 ? 2 : 1,
        flowControl: p.flow === 'hardware' ? 'hardware' : 'none',
        bufferSize: 16384,
    };
}

const sameOptions = (a, b) => !!a && !!b && ['baudRate', 'dataBits', 'parity', 'stopBits', 'flowControl'].every((k) => a[k] === b[k]);

/** Text to the bytes a port sends, by encoding. Hex reads pairs of hex digits and ignores the rest. */
export function encodeText(text, encoding) {
    const s = String(text);
    if (encoding === 'hex') {
        const pairs = s.match(/[0-9a-fA-F]{2}/g) || [];
        return Uint8Array.from(pairs.map((h) => parseInt(h, 16)));
    }
    if (encoding === 'latin1' || encoding === 'ascii') {
        const mask = encoding === 'ascii' ? 0x7f : 0xff;
        const out = new Uint8Array(s.length);
        for (let k = 0; k < s.length; k++) {
            const c = s.charCodeAt(k);
            out[k] = c > mask ? 0x3f : c; // '?' for what the encoding has not got
        }
        return out;
    }
    return new TextEncoder().encode(s);
}

/**
 * A decoder for bytes coming in: `decode(bytes)` gives the text so far. UTF-8
 * keeps a character split across two reads whole; hex writes each byte as two
 * digits and a space, and starts a new line after a line feed so a log of it
 * still reads by line.
 */
export function makeDecoder(encoding) {
    if (encoding === 'hex') {
        return (bytes) => {
            let s = '';
            for (const b of bytes) s += `${b.toString(16).padStart(2, '0')}${b === 0x0a ? '\n' : ' '}`;
            return s;
        };
    }
    if (encoding === 'latin1' || encoding === 'ascii') {
        const mask = encoding === 'ascii' ? 0x7f : 0xff;
        return (bytes) => {
            let s = '';
            for (const b of bytes) s += String.fromCharCode(b & mask);
            return s;
        };
    }
    const dec = new TextDecoder('utf-8');
    return (bytes) => dec.decode(bytes, { stream: true });
}

/** A port's name for the card, from what it says about itself. */
export function portLabel(port) {
    const info = (port && port.getInfo && port.getInfo()) || {};
    const hex = (v) => v.toString(16).padStart(4, '0');
    if (info.usbVendorId != null) return `USB ${hex(info.usbVendorId)}:${hex(info.usbProductId || 0)}`;
    if (info.bluetoothServiceClassId) return 'Bluetooth serial';
    return 'Serial port';
}

function readMemory() {
    try {
        return JSON.parse(localStorage.getItem(SERIAL_MEMORY_KEY) || '{}') || {};
    } catch (err) {
        return {};
    }
}

function writeMemory(m) {
    try { localStorage.setItem(SERIAL_MEMORY_KEY, JSON.stringify(m)); } catch (err) { /* private mode */ }
}

const LINE_NAMES = { cts: 'clearToSend', dsr: 'dataSetReady', dcd: 'dataCarrierDetect', ri: 'ringIndicator' };

export class SerialLink extends Emitter {
    /**
     * `id` is the block's. `serial` is navigator.serial, or a stand-in for the
     * tests; `now` a clock in ms; `timer` setTimeout's shape.
     */
    constructor(id, { serial = typeof navigator === 'undefined' ? null : navigator.serial, now = () => performance.now(), timer = (fn, ms) => setTimeout(fn, ms), clear = (h) => clearTimeout(h) } = {}) {
        super();
        this.id = id;
        this.serial = serial || null;
        this._now = now;
        this._timer = timer;
        this._clear = clear;
        this.state = this.serial ? 'idle' : 'unsupported';
        this.message = '';
        this.label = '';
        this.rxBytes = 0;
        this.txBytes = 0;
        this.port = null;
        this.options = null;
        this.params = {};
        this.lines = { cts: false, dsr: false, dcd: false, ri: false };
        this.listening = false;
        this._inText = [];
        this._inChars = 0;
        this._edges = [];
        this._decode = null;
        this._writing = Promise.resolve();
        this._queued = 0;
        this._signals = { dtr: false, rts: false };
        this._wantSignals = { dtr: false, rts: false };
        this._setting = false;
        this._keyNext = 0;
        this._keyTimers = new Set();
        this._keyState = null;
        this._poll = null;
        this._active = false;
    }

    _set(state, message = '') {
        this.state = state;
        this.message = message;
        this.emit('change');
    }

    /** The port this block had last time in this browser, by name, or ''. */
    remembered() {
        const m = readMemory()[this.id];
        return m && m.label ? m.label : '';
    }

    /**
     * Open a port, from a press. `pick` asks the operator to choose one;
     * otherwise the one this block had before is tried first, and the picker
     * only if it is not there.
     */
    async connect(params, { pick = false } = {}) {
        if (!this.serial) return false;
        this.params = params || this.params;
        let port = null;
        if (!pick) {
            const want = readMemory()[this.id];
            if (want) {
                try {
                    const ports = await this.serial.getPorts();
                    port = ports.find((pt) => {
                        const info = (pt.getInfo && pt.getInfo()) || {};
                        return info.usbVendorId === want.usbVendorId && info.usbProductId === want.usbProductId;
                    }) || null;
                } catch (err) { port = null; }
            }
        }
        if (!port) {
            try {
                port = await this.serial.requestPort();
            } catch (err) {
                // Dismissing the picker is not a fault.
                if (err && err.name === 'NotFoundError') return false;
                this._set('error', `Could not choose a port: ${(err && err.message) || err}`);
                return false;
            }
        }
        return this._open(port);
    }

    async _open(port) {
        await this.disconnect({ quiet: true });
        this._set('connecting');
        const options = portOptions(this.params);
        try {
            await port.open(options);
        } catch (err) {
            const busy = err && err.name === 'InvalidStateError';
            this._set('error', busy
                ? 'That port is already open — perhaps by rig control or a FlexControl on this page, or another program.'
                : `Could not open the port: ${(err && err.message) || err}`);
            return false;
        }
        this.port = port;
        this.options = options;
        this.label = portLabel(port);
        this._decode = makeDecoder(this.params.encoding);
        this.rxBytes = 0;
        this.txBytes = 0;
        const info = (port.getInfo && port.getInfo()) || {};
        if (info.usbVendorId != null) {
            const m = readMemory();
            m[this.id] = { usbVendorId: info.usbVendorId, usbProductId: info.usbProductId, label: this.label };
            writeMemory(m);
        }
        this._signals = { dtr: null, rts: null };
        this._wantSignals = { dtr: false, rts: false };
        this._applySignals();
        this._readLoop(port);
        this._startPoll();
        this._set('open');
        return true;
    }

    /** Close the port, lines dropped first. */
    async disconnect({ quiet = false } = {}) {
        const port = this.port;
        this._stopPoll();
        this._cancelKey();
        if (!port) {
            if (!quiet && this.state !== 'unsupported') this._set('idle');
            return;
        }
        this.port = null;
        try { await port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch (err) { /* gone already */ }
        try { if (this._reader) await this._reader.cancel(); } catch (err) { /* already done */ }
        try { await this._writing; } catch (err) { /* nothing to wait for */ }
        try { await port.close(); } catch (err) { /* unplugged */ }
        this._reader = null;
        this._signals = { dtr: false, rts: false };
        if (!quiet) this._set('idle');
    }

    /** Forget the port this block had, so the next connect asks. */
    forget() {
        const m = readMemory();
        delete m[this.id];
        writeMemory(m);
        this.emit('change');
    }

    async _readLoop(port) {
        while (this.port === port && port.readable) {
            const reader = port.readable.getReader();
            this._reader = reader;
            try {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    if (value && value.length) this._received(value);
                }
            } catch (err) {
                // A framing or parity error is reported and reading goes on;
                // anything else — unplugged — ends it.
                const recoverable = err && ['BreakError', 'FramingError', 'ParityError', 'BufferOverrunError'].includes(err.name);
                if (!recoverable) {
                    if (this.port === port) {
                        this.port = null;
                        this._stopPoll();
                        this._cancelKey();
                        this._set('error', `The port went away: ${(err && err.message) || err}`);
                    }
                    break;
                }
            } finally {
                try { reader.releaseLock(); } catch (err) { /* already released */ }
            }
        }
    }

    _received(bytes) {
        this.rxBytes += bytes.length;
        const text = (this._decode || makeDecoder('utf-8'))(bytes);
        if (!text) return;
        // Only while the graph runs: otherwise nothing will take it, and it
        // would arrive all at once on the next Start.
        if (!this._active) return;
        this._inText.push(text);
        this._inChars += text.length;
        while (this._inChars > RX_HOLD_CHARS && this._inText.length > 1) this._inChars -= this._inText.shift().length;
        this.emit('activity');
    }

    // ── the input lines ──

    /** Whether anything in the graph listens to the input lines: polled fast if so. */
    setListening(on) {
        this.listening = !!on;
    }

    _startPoll() {
        this._stopPoll();
        const port = this.port;
        const tick = async () => {
            if (this.port !== port || !port.getSignals) return;
            try {
                const s = await port.getSignals();
                const next = {};
                for (const [k, name] of Object.entries(LINE_NAMES)) next[k] = !!s[name];
                if (Object.keys(next).some((k) => next[k] !== this.lines[k])) {
                    this.lines = next;
                    if (this._active) this._edges.push({ lines: { ...next }, t: this._now() });
                    this.emit('lines');
                }
            } catch (err) { /* a read that failed: try again next time */ }
            if (this.port === port) this._poll = this._timer(tick, this.listening ? POLL_FAST_MS : POLL_SLOW_MS);
        };
        tick();
    }

    _stopPoll() {
        if (this._poll != null) this._clear(this._poll);
        this._poll = null;
    }

    /**
     * What came in since the last packet, for the packet about to be sent:
     * `{ text, signals }` with each line change placed `frac` of the way into
     * a packet `packetMs` long ending now — or null when there is nothing.
     */
    takeInbound(packetMs) {
        // Nothing for a graph that is not running: it has no packet to put it in.
        if (!this.port || !this._active) return null;
        const t = this._now();
        const signals = this._edges.map((e) => ({
            lines: e.lines,
            frac: packetMs > 0 ? Math.max(0, Math.min(1, 1 - (t - e.t) / packetMs)) : 0,
        }));
        this._edges = [];
        // The lines as they stand, once, so a graph started after they last
        // changed still knows them.
        if (!this._told) {
            signals.unshift({ lines: { ...this.lines }, frac: 0 });
            this._told = true;
        }
        const text = this._inText;
        this._inText = [];
        this._inChars = 0;
        if (!text.length && !signals.length) return null;
        return { text, signals };
    }

    // ── going out ──

    /** The graph running or not: stopped, the lines drop and nothing is sent. */
    setActive(on) {
        this._active = !!on;
        this._told = false;
        if (!on) {
            this._cancelKey();
            this._inText = [];
            this._inChars = 0;
            this._edges = [];
            this._wantSignals = { dtr: false, rts: false };
            this._applySignals();
        }
    }

    /** New settings: a port opened differently is reopened; a new encoding takes effect at once. */
    async setParams(params) {
        const was = this.params || {};
        this.params = params;
        if (params.encoding !== was.encoding) this._decode = makeDecoder(params.encoding);
        if (this.port && !sameOptions(portOptions(params), this.options)) {
            const port = this.port;
            await this.disconnect({ quiet: true });
            await this._open(port);
        }
    }

    /**
     * One packet's going-out from the graph: text to send, and the lines.
     * `packetMs` is how long that packet was, for playing its key changes out.
     */
    deliver(out, packetMs = 20) {
        if (!this.port || !this._active || !out) return;
        if (out.tx) this._write(out.tx);
        const keyed = out.keyLine === 'dtr' || out.keyLine === 'rts' ? out.keyLine : null;
        const base = { dtr: !!out.dtr, rts: !!out.rts };
        // Whatever the key does not drive follows the settings now.
        this._wantSignals = { ...this._wantSignals, ...base };
        if (keyed && out.key != null) {
            const now = this._now();
            // Against a clock of its own: a packet starts where the last ended,
            // unless that has fallen behind or run away.
            const start = this._keyNext > now && this._keyNext < now + 4 * KEY_DELAY_MS + packetMs ? this._keyNext : now + KEY_DELAY_MS;
            this._keyNext = start + packetMs;
            for (const e of out.edges || []) {
                const at = start + e.at * 1000;
                const h = this._timer(() => {
                    this._keyTimers.delete(h);
                    this._keyState = e.on;
                    this._applySignals();
                }, Math.max(0, at - now));
                this._keyTimers.add(h);
            }
            if (this._keyState === null) this._keyState = !!out.key;
        } else {
            this._cancelKey();
        }
        this._keyLine = keyed && out.key != null ? keyed : null;
        this._applySignals();
    }

    _cancelKey() {
        for (const h of this._keyTimers) this._clear(h);
        this._keyTimers.clear();
        this._keyState = null;
        this._keyNext = 0;
    }

    _applySignals() {
        const want = { ...this._wantSignals };
        if (this._keyLine && this._keyState !== null) want[this._keyLine] = !!this._keyState;
        if (!this._active) { want.dtr = false; want.rts = false; }
        this._target = want;
        if (this._setting || !this.port) return;
        if (want.dtr === this._signals.dtr && want.rts === this._signals.rts) return;
        const port = this.port;
        this._setting = true;
        const sent = { ...want };
        Promise.resolve(port.setSignals({ dataTerminalReady: sent.dtr, requestToSend: sent.rts }))
            .then(() => { this._signals = sent; }, () => {})
            .finally(() => {
                this._setting = false;
                // What changed while that was on its way.
                if (this.port === port && (this._target.dtr !== this._signals.dtr || this._target.rts !== this._signals.rts)) this._applySignals();
                this.emit('lines');
            });
    }

    /** The lines this end is driving, as last set. */
    get outLines() {
        return { dtr: !!this._signals.dtr, rts: !!this._signals.rts };
    }

    _write(text) {
        const bytes = encodeText(text, this.params.encoding);
        if (!bytes.length) return;
        if (this._queued + bytes.length > TX_HOLD_BYTES) {
            this.message = 'Sending faster than the port can take: some was dropped.';
            this.emit('change');
            return;
        }
        this._queued += bytes.length;
        const port = this.port;
        this._writing = this._writing.then(async () => {
            if (this.port !== port || !port.writable) return;
            const w = port.writable.getWriter();
            try {
                await w.write(bytes);
                this.txBytes += bytes.length;
            } catch (err) {
                this.message = `Could not send: ${(err && err.message) || err}`;
                this.emit('change');
            } finally {
                this._queued -= bytes.length;
                try { w.releaseLock(); } catch (err) { /* released */ }
            }
            this.emit('activity');
        });
    }
}

// Every link on the page, so that leaving it drops their lines.
const LINKS = new Set();
export function trackLink(link) {
    LINKS.add(link);
    return () => LINKS.delete(link);
}
if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('pagehide', () => {
        for (const l of LINKS) {
            try {
                if (l.port) l.port.setSignals({ dataTerminalReady: false, requestToSend: false });
            } catch (err) { /* going anyway */ }
        }
    });
}
