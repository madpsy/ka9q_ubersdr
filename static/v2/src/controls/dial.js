// UberSDR Dial — the round ESP32-S3 knob display (github: madpsy/ubersdr_dial),
// in its controller mode: over Web Bluetooth, or over a USB cable with Web
// Serial. The records below are the same either way; only how they travel
// differs (see "USB" after the GATT table).
//
// Unlike the other surfaces this one is two-way. The dial sends knob turns and
// taps like any controller; the page sends back what the receiver is doing —
// frequency, mode, SNR, squelch, volume, passband — so the dial's own screen,
// rim meter and LED ring show the receiver it is driving.
//
// GATT (all little-endian), service 89540001-8c77-4d5f-9411-e7534b50c873:
//
//   input  89540002-…  notify  dial -> page. 2-byte records [code u8][value i8],
//                               several may share one notification.
//          code 1..6   knob turned on page tune/volume/zoom/squelch/bandwidth/step,
//                      value = signed detents (+ clockwise)
//          code 16..22 mode tap/hold, freq tap/hold, mute tap/hold, centre tap
//          code 32+i   set mode DIAL_MODES[i]          (the dial's mode picker)
//          code 48+i   go to band DIAL_BANDS[i]        (its band picker)
//          code 64+i   set step TUNING_STEPS[i]        (its step picker)
//          code 80..85 lock toggle, squelch on/off, auto squelch, zoom in,
//                      zoom out, zoom reset            (its quick sheets)
//          code 97     drag across the dial's waterfall: value = pixels moved
//                      out of 360 (+ = right), one event, not per detent
//          code 98     tap on the dial's waterfall: value = where, -127..127
//                      across the view (left..right edge); tune there
//          code 96     waterfall lines per second the dial wants (value 1..20;
//                      its battery/smooth setting) — handled here, not mapped
//   state  89540003-…  write   page -> dial, 20 bytes:
//          [0] version = 1
//          [1..4]  frequency Hz u32       [5] mode index (DIAL_MODES), 255 = ?
//          [6] snr dB i8, -128 = none     [7] flags: b0 audio up, b1 squelch on,
//                                                    b2 squelch open, b3 muted,
//                                                    b4 tuning locked
//          [8] volume 0..100              [9] squelch threshold dB i8, -128 off
//          [10..11] passband low Hz i16   [12..13] passband high Hz i16
//          [14..17] tuning step Hz u32    [18..19] reserved
//   name   89540004-…  write   page -> dial: receiver name, UTF-8, <= 32 bytes
//   spec   89540005-…  write   page -> dial: a spectrum line for its waterfall,
//          [0] version = 1  [1] line seq u8  [2] first point  [3] point count
//          [4..7] centre Hz u32  [8..11] span Hz u32  [12..] one byte per point,
//          dB = byte / 2 - 160. SPEC_POINTS points per line, sent whole, or in
//          8-point pieces where the link won't carry a long write.
//
// USB: the dial's USB serial port also carries its log text, so each record
// travels in a frame — [type u8][payload][crc16 LE], CRC-16/CCITT-FALSE over
// type + payload, COBS-encoded, with a zero byte either side. Text never has a
// zero byte in it, so the reader splits on zeros and drops whatever fails the
// CRC. Types:
//   1 hello  page -> dial [1], on open and once a second; dial -> page
//            [1][its name, UTF-8], the answer to each
//   2 input  dial -> page, as the input notification
//   3 state  4 name  5 spec   page -> dial, as the characteristics above
//            (spec always whole: USB has no write-length limit to work round)
//   6 bye    page -> dial, closing
// A hello connects; after that any frame keeps the link up, both ways, and
// three seconds of silence (the dial) or four (here) counts as gone.
//
// The same table lives in the dial's firmware (docs/PROTOCOL.md there);
// change both together.

import { Emitter } from '../radio/emitter.js';
import { MODES, TUNING_STEPS } from '../radio/constants.js';

export const DIAL_SERVICE = '89540001-8c77-4d5f-9411-e7534b50c873';
export const DIAL_INPUT = '89540002-8c77-4d5f-9411-e7534b50c873';
export const DIAL_STATE = '89540003-8c77-4d5f-9411-e7534b50c873';
export const DIAL_NAME = '89540004-8c77-4d5f-9411-e7534b50c873';
export const DIAL_SPEC = '89540005-8c77-4d5f-9411-e7534b50c873';
export const SPEC_POINTS = 160;

/**
 * A spectrum frame as the dial's waterfall line(s): resampled to SPEC_POINTS
 * by the peak in each slot (a signal narrower than a slot must not vanish),
 * quantised to 0.5 dB. Returns an array of packets, `chunk` points each.
 */
export function encodeSpectrum(bins, centerHz, spanHz, seq, chunk = SPEC_POINTS) {
    const n = bins.length;
    const pts = new Uint8Array(SPEC_POINTS);
    for (let p = 0; p < SPEC_POINTS; p += 1) {
        const a = Math.floor((p * n) / SPEC_POINTS);
        const b = Math.max(a + 1, Math.floor(((p + 1) * n) / SPEC_POINTS));
        let peak = -Infinity;
        for (let i = a; i < b && i < n; i += 1) if (bins[i] > peak) peak = bins[i];
        pts[p] = Number.isFinite(peak) ? Math.max(0, Math.min(255, Math.round((peak + 160) * 2))) : 0;
    }
    const out = [];
    for (let off = 0; off < SPEC_POINTS; off += chunk) {
        const count = Math.min(chunk, SPEC_POINTS - off);
        const buf = new Uint8Array(12 + count);
        const v = new DataView(buf.buffer);
        v.setUint8(0, 1);
        v.setUint8(1, seq & 0xff);
        v.setUint8(2, off);
        v.setUint8(3, count);
        v.setUint32(4, Math.max(0, Math.min(0xffffffff, Math.round(centerHz || 0))), true);
        v.setUint32(8, Math.max(0, Math.min(0xffffffff, Math.round(spanHz || 0))), true);
        buf.set(pts.subarray(off, off + count), 12);
        out.push(buf);
    }
    return out;
}
export const STATE_BYTES = 20;

// Mode index sent in the state. The v2 mode table's order, IQ included, so the
// dial can name whatever mode the receiver is in.
export const DIAL_MODES = MODES.map((m) => m.id);

const PAGES = { 1: 'tune', 2: 'vol', 3: 'zoom', 4: 'sql', 5: 'bw', 6: 'step' };
const BUTTONS = {
    16: 'mode_tap', 17: 'mode_hold', 18: 'freq_tap', 19: 'freq_hold', 20: 'mute_tap', 21: 'mute_hold',
    22: 'center_tap',
};

export const DIAL_KEYS = [
    { key: 'tune_up', label: 'Knob (TUNE) — clockwise' },
    { key: 'tune_down', label: 'Knob (TUNE) — anticlockwise' },
    { key: 'vol_up', label: 'Knob (VOL) — clockwise' },
    { key: 'vol_down', label: 'Knob (VOL) — anticlockwise' },
    { key: 'zoom_up', label: 'Knob (ZOOM) — clockwise' },
    { key: 'zoom_down', label: 'Knob (ZOOM) — anticlockwise' },
    { key: 'sql_up', label: 'Knob (SQL) — clockwise' },
    { key: 'sql_down', label: 'Knob (SQL) — anticlockwise' },
    { key: 'bw_up', label: 'Knob (BW) — clockwise' },
    { key: 'bw_down', label: 'Knob (BW) — anticlockwise' },
    { key: 'step_up', label: 'Knob (STEP) — clockwise' },
    { key: 'step_down', label: 'Knob (STEP) — anticlockwise' },
    { key: 'mode_tap', label: 'Mode — tap' },
    { key: 'mode_hold', label: 'Mode — hold' },
    { key: 'freq_tap', label: 'Frequency — tap' },
    { key: 'freq_hold', label: 'Frequency — hold' },
    { key: 'mute_tap', label: 'Mute — tap' },
    { key: 'mute_hold', label: 'Mute — hold' },
    { key: 'center_tap', label: 'Centre — tap' },
    { key: 'pan_drag', label: 'Drag — pan the waterfall' },
    { key: 'tap_tune', label: 'Tap — tune to that point' },
];

// Bands in the order the dial's picker numbers them (v2's band functions).
export const DIAL_BANDS = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m'];

const ACTIONS = {
    80: ['lock_toggle', 'Tuning lock — toggle', 'tune_lock_toggle'],
    81: ['sql_toggle', 'Squelch on/off', 'squelch_toggle'],
    82: ['sql_auto', 'Squelch — auto', 'squelch_auto'],
    83: ['zoom_in', 'Zoom in', 'zoom_in'],
    84: ['zoom_out', 'Zoom out', 'zoom_out'],
    85: ['zoom_reset', 'Zoom — reset', 'spectrum_reset'],
};

// The "set exactly this" commands the dial's pickers send. Each maps to the
// catalogue function of the same meaning, so the panel's labels are v2's own.
const DIRECT = {};
DIAL_MODES.forEach((id, i) => {
    const mode = MODES[i];
    DIRECT[32 + i] = [`mode_${id}`, `Mode picker — ${mode.label}`, `mode_${id}`];
});
DIAL_BANDS.forEach((b, i) => { DIRECT[48 + i] = [`band_${b}`, `Band picker — ${b}`, `band_${b}`]; });
TUNING_STEPS.forEach((hz, i) => {
    DIRECT[64 + i] = [`step_${hz}`, `Step picker — ${hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`}`, `rx_step_${hz}`];
});
Object.assign(DIRECT, ACTIONS);
for (const [key, label] of Object.values(DIRECT)) DIAL_KEYS.push({ key, label });

const KEY_LABEL = Object.fromEntries(DIAL_KEYS.map((k) => [k.key, k.label]));

export function dialKeyLabel(key) {
    return KEY_LABEL[key] || key;
}

const m = (fn) => ({ function: fn, throttleMs: 0, mode: 'none' });

// Arrives mapped, like the RC-28: every page of the knob does what its label on
// the dial says. A saved table wins, as for every surface.
export const DIAL_DEFAULT_MAPPINGS = {
    // The Receiver panel's step, which the dial also shows — not the SDR
    // Control panel's own step, which the Dial's section doesn't offer.
    tune_up: m('freq_rx_step'),
    tune_down: m('freq_rx_step'),
    vol_up: m('volume_up'),
    vol_down: m('volume_down'),
    zoom_up: m('zoom_dial'),
    zoom_down: m('zoom_dial'),
    sql_up: m('squelch_set'),
    sql_down: m('squelch_set'),
    bw_up: m('bw_widen'),
    bw_down: m('bw_narrow'),
    step_up: m('rx_step_dial'),
    step_down: m('rx_step_dial'),
    mode_tap: m('mode_next'),
    mode_hold: m('mode_prev'),
    freq_tap: m('spectrum_center'),
    mute_tap: m('mute_toggle'),
    // The dial's own centre button: the waterfall toolbar's "centre on tuned".
    center_tap: m('spectrum_center'),
    pan_drag: m('spectrum_pan'),
    tap_tune: m('spectrum_tune_at'),
};
for (const [key, , fn] of Object.values(DIRECT)) DIAL_DEFAULT_MAPPINGS[key] = m(fn);

/**
 * A saved table from before freq_rx_step: the first defaults tuned by the SDR
 * Control panel's step, which the Dial section no longer shows. Moved over only
 * when both directions are still exactly those defaults.
 */
export function upgradeDialTune(mappings) {
    if (!mappings) return mappings;
    let out = mappings;
    const up = out.tune_up;
    const down = out.tune_down;
    if (up && down && up.function === 'freq_step_up' && down.function === 'freq_step_down') {
        out = { ...out, tune_up: DIAL_DEFAULT_MAPPINGS.tune_up, tune_down: DIAL_DEFAULT_MAPPINGS.tune_down };
    }
    // Controls added after a table was saved arrive mapped rather than dead.
    // (The Dial's section has no mapping editor, so nothing here was removed
    // on purpose.)
    for (const [key, mapping] of Object.entries(DIAL_DEFAULT_MAPPINGS)) {
        if (!out[key]) out = { ...out, [key]: mapping };
    }
    return out;
}

export const DIAL_LINKS = ['bluetooth', 'usb'];

// The dial's USB serial port: Espressif's own USB-Serial/JTAG (ESP32-S3).
export const DIAL_USB_FILTER = { usbVendorId: 0x303a, usbProductId: 0x1001 };

export function dialAvailable(link = 'bluetooth') {
    if (typeof navigator === 'undefined') return false;
    return link === 'usb' ? 'serial' in navigator : !!navigator.bluetooth;
}

// --- USB framing -------------------------------------------------------------

export const FRAME = { HELLO: 1, INPUT: 2, STATE: 3, NAME: 4, SPEC: 5, BYE: 6 };

export function crc16(bytes) {
    let c = 0xffff;
    for (const b of bytes) {
        c ^= b << 8;
        for (let i = 0; i < 8; i += 1) c = (c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1) & 0xffff;
    }
    return c;
}

function cobsEncode(raw) {
    const out = [0];
    let codeAt = 0;
    let code = 1;
    for (const b of raw) {
        if (b) { out.push(b); code += 1; }
        if (!b || code === 0xff) { out[codeAt] = code; codeAt = out.length; out.push(0); code = 1; }
    }
    out[codeAt] = code;
    return out;
}

function cobsDecode(buf) {
    const out = [];
    let i = 0;
    while (i < buf.length) {
        const code = buf[i++];
        if (!code || i + code - 1 > buf.length) return null;
        for (let k = 1; k < code; k += 1) out.push(buf[i++]);
        if (code < 0xff && i < buf.length) out.push(0);
    }
    return out;
}

/** One frame, ready to write: zero, COBS(type + payload + crc), zero. */
export function encodeFrame(type, payload = new Uint8Array(0)) {
    const raw = new Uint8Array(payload.length + 3);
    raw[0] = type;
    raw.set(payload, 1);
    const c = crc16(raw.subarray(0, payload.length + 1));
    raw[payload.length + 1] = c & 0xff;
    raw[payload.length + 2] = c >> 8;
    return Uint8Array.from([0, ...cobsEncode(raw), 0]);
}

/**
 * Splits what the port has sent so far into frames. Feed it bytes; it returns
 * `[{ type, payload }]` for every good frame completed, and keeps the
 * unfinished tail. Log text between frames fails the CRC and is dropped.
 */
export class FrameReader {
    constructor() { this.buf = []; }

    push(bytes) {
        const out = [];
        for (const b of bytes) {
            if (b !== 0) {
                // Nothing a frame needs is this long: it is a run of log text.
                if (this.buf.length < 1024) this.buf.push(b);
                continue;
            }
            const chunk = this.buf;
            this.buf = [];
            if (!chunk.length || chunk.length >= 1024) continue;
            const f = cobsDecode(chunk);
            if (!f || f.length < 3) continue;
            const n = f.length;
            if (crc16(f.slice(0, n - 2)) !== (f[n - 2] | (f[n - 1] << 8))) continue;
            out.push({ type: f[0], payload: Uint8Array.from(f.slice(1, n - 2)) });
        }
        return out;
    }
}

/** One notification as `[{ key, event }]` — one entry per detent or press. */
export function parseInput(bytes) {
    const out = [];
    for (let i = 0; i + 1 < bytes.length; i += 2) {
        const code = bytes[i];
        const value = bytes[i + 1] > 127 ? bytes[i + 1] - 256 : bytes[i + 1];
        if (code === 97 && value) {
            // A drag is one movement, not a run of detents.
            out.push({ key: 'pan_drag', event: { kind: 'relative', delta: value } });
        } else if (code === 98) {
            // A tap's position; 0 (dead centre) is a real position here.
            out.push({ key: 'tap_tune', event: { kind: 'relative', delta: value } });
        } else if (PAGES[code] && value) {
            // One event per detent: the catalogue's press-type functions
            // (step, volume, bandwidth) act once per event, whatever its size.
            const key = `${PAGES[code]}_${value > 0 ? 'up' : 'down'}`;
            const one = value > 0 ? 1 : -1;
            for (let n = 0; n < Math.abs(value); n += 1) out.push({ key, event: { kind: 'relative', delta: one } });
        } else if (BUTTONS[code]) {
            out.push({ key: BUTTONS[code], event: { kind: 'trigger' } });
        } else if (DIRECT[code]) {
            out.push({ key: DIRECT[code][0], event: { kind: 'trigger' } });
        }
    }
    return out;
}

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

/**
 * The receiver as the dial's state record. `s` is plain values so this stays
 * testable without a radio: { frequency, mode, snr, audioUp, squelchOn,
 * squelchOpen, muted, locked, volume (0..1), squelchDb, bwLow, bwHigh, stepHz }.
 */
export function encodeState(s) {
    const buf = new ArrayBuffer(STATE_BYTES);
    const v = new DataView(buf);
    v.setUint8(0, 1);
    v.setUint32(1, clampInt(s.frequency || 0, 0, 0xffffffff), true);
    const mi = DIAL_MODES.indexOf(s.mode);
    v.setUint8(5, mi < 0 ? 255 : mi);
    v.setInt8(6, s.snr == null || !Number.isFinite(s.snr) ? -128 : clampInt(s.snr, -127, 127));
    v.setUint8(7, (s.audioUp ? 1 : 0) | (s.squelchOn ? 2 : 0) | (s.squelchOpen ? 4 : 0)
        | (s.muted ? 8 : 0) | (s.locked ? 16 : 0));
    v.setUint8(8, clampInt((s.volume || 0) * 100, 0, 100));
    v.setInt8(9, s.squelchDb == null ? -128 : clampInt(s.squelchDb, -127, 127));
    v.setInt16(10, clampInt(s.bwLow || 0, -32768, 32767), true);
    v.setInt16(12, clampInt(s.bwHigh || 0, -32768, 32767), true);
    v.setUint32(14, clampInt(s.stepHz || 0, 0, 0xffffffff), true);
    return new Uint8Array(buf);
}

// How often the page says hello over USB, and how long the dial may stay quiet.
const HELLO_MS = 1000;
const SILENT_MS = 4000;

export class DialControl extends Emitter {
    constructor() {
        super();
        // 'bluetooth' or 'usb': which way connect() and autoConnect() reach.
        this.link = 'bluetooth';
        this.device = null;
        this.stateChar = null;
        this.nameChar = null;
        this.specChar = null;
        // USB: the open port, and whether it is open but the dial has not
        // answered yet (still on its start screen, say).
        this.port = null;
        this.waiting = false;
        this._reader = null;
        this._writer = null;
        this._lastHello = 0;
        this._lastHeard = 0;
        this._timer = null;
        this._specSeq = 0;
        this._specBusy = false;
        this._specChunk = SPEC_POINTS;
        // How often the dial wants a waterfall line; it says so on connect.
        this.spectrumIntervalMs = 200;
        this.connected = false;
        this.deviceName = '';
        this._lastState = '';
        // GATT allows one operation at a time; a second write while one is in
        // flight is rejected ("operation already in progress"). Every write goes
        // through this chain so state, name and spectrum never collide.
        //
        // And every write waits for the dial's acknowledgement (WithResponse).
        // A write *without* response resolves as soon as the OS has queued it,
        // so on a slow link the queue grew without limit and the dial fell ten
        // seconds behind. Acknowledged writes can't pile up: a slow link skips
        // waterfall lines instead, and state is always the latest.
        //
        // USB keeps the same chain: a port write resolves once the bytes are
        // handed over, so the same rule (newest state, skip a busy line) holds.
        this._chain = Promise.resolve();
        this._stateQueued = false;
        this._pending = null;
        this._onDisconnect = () => this._lost();
    }

    /** Bluetooth or USB. Changing it lets go of whatever the other one holds. */
    setLink(link) {
        const next = link === 'usb' ? 'usb' : 'bluetooth';
        if (next === this.link) return;
        if (this.connected || this.port || this.device) this.disconnect();
        this.link = next;
    }

    // Must be called from a user gesture — the device chooser is gated on one.
    async connect() {
        if (this.link === 'usb') return this._connectUsb();
        if (!dialAvailable('bluetooth')) {
            this.emit('message', { text: 'This browser has no Web Bluetooth — Chrome or Edge is needed.', tone: 'error' });
            return false;
        }
        let device;
        try {
            device = await navigator.bluetooth.requestDevice({ filters: [{ services: [DIAL_SERVICE] }] });
        } catch (err) {
            if (err && err.name !== 'NotFoundError') {
                this.emit('message', { text: `Could not pick the dial: ${err.message}`, tone: 'error' });
            }
            return false;
        }
        return this._start(device, false);
    }

    // Reopens a dial this origin was already allowed to use. For Bluetooth,
    // getDevices() is only there with Chrome's persistent-permissions support;
    // without it this quietly does nothing and Connect is a click away. For
    // USB, it is a port already picked here once.
    async autoConnect() {
        if (this.connected || this.port) return false;
        if (this.link === 'usb') {
            if (!dialAvailable('usb')) return false;
            let ports;
            try {
                ports = await navigator.serial.getPorts();
            } catch (err) {
                return false;
            }
            const port = (ports || []).find((p) => {
                const info = (p.getInfo && p.getInfo()) || {};
                return info.usbVendorId === DIAL_USB_FILTER.usbVendorId
                    && info.usbProductId === DIAL_USB_FILTER.usbProductId;
            });
            return port ? this._startUsb(port, true) : false;
        }
        if (!dialAvailable('bluetooth') || !navigator.bluetooth.getDevices) return false;
        let devices;
        try {
            devices = await navigator.bluetooth.getDevices();
        } catch (err) {
            return false;
        }
        const device = (devices || [])[0];
        if (!device) return false;
        return this._start(device, true);
    }

    // The dial's own preference for the waterfall rate rides in the input
    // stream; it is a setting, not a control to map.
    _input(bytes) {
        for (let i = 0; i + 1 < bytes.length; i += 2) {
            if (bytes[i] === 96 && bytes[i + 1] >= 1 && bytes[i + 1] <= 20) {
                this.spectrumIntervalMs = Math.round(1000 / bytes[i + 1]);
            }
        }
        for (const ev of parseInput(bytes)) this.emit('input', ev);
    }

    _resetLink() {
        this._lastState = '';
        this._usbName = null;
        this._usbState = null;
        this._chain = Promise.resolve();
        this._stateQueued = false;
        this._pending = null;
        this._specBusy = false;
    }

    async _start(device, quiet) {
        try {
            const server = await device.gatt.connect();
            const service = await server.getPrimaryService(DIAL_SERVICE);
            const input = await service.getCharacteristic(DIAL_INPUT);
            this.stateChar = await service.getCharacteristic(DIAL_STATE);
            this.nameChar = await service.getCharacteristic(DIAL_NAME).catch(() => null);
            // Older dial firmware has no waterfall: then there's simply nothing to send.
            this.specChar = await service.getCharacteristic(DIAL_SPEC).catch(() => null);
            input.addEventListener('characteristicvaluechanged', (e) => {
                this._input(new Uint8Array(e.target.value.buffer));
            });
            await input.startNotifications();
        } catch (err) {
            if (!quiet) this.emit('message', { text: `Could not connect to the dial: ${err.message}`, tone: 'error' });
            try { device.gatt.disconnect(); } catch (e) { /* not connected */ }
            return false;
        }
        this.device = device;
        this.deviceName = device.name || 'UberSDR Dial';
        device.addEventListener('gattserverdisconnected', this._onDisconnect);
        this.connected = true;
        this._resetLink();
        this.emit('state', { connected: true });
        this.emit('message', { text: `${this.deviceName} connected`, tone: 'good' });
        return true;
    }

    // --- USB -----------------------------------------------------------------

    async _connectUsb() {
        if (!dialAvailable('usb')) {
            this.emit('message', { text: 'This browser has no Web Serial API — Chrome or Edge is needed.', tone: 'error' });
            return false;
        }
        let port;
        try {
            port = await navigator.serial.requestPort({ filters: [DIAL_USB_FILTER] });
        } catch (err) {
            if (err && err.name !== 'NotFoundError') {
                this.emit('message', { text: `Could not open the port: ${err.message}`, tone: 'error' });
            }
            return false;
        }
        return this._startUsb(port, false);
    }

    // Opens the port and waits there for the dial to answer. The port being
    // open isn't the dial being connected: it may be on its start screen, or
    // in another mode, and it answers once Controller · USB is chosen on it.
    //
    // Opening touches neither DTR nor RTS on purpose — the board's USB port
    // resets the chip into its bootloader when those are toggled.
    async _startUsb(port, quiet) {
        try {
            await port.open({ baudRate: 115200, bufferSize: 4096 });
        } catch (err) {
            if (!quiet) this.emit('message', { text: `Could not open the port: ${err.message}`, tone: 'error' });
            return false;
        }
        this.port = port;
        this._writer = port.writable.getWriter();
        this._resetLink();
        this.waiting = true;
        this._lastHello = -Infinity;  // the first goes now
        this._lastHeard = 0;
        this.emit('state', { connected: false, waiting: true });
        if (!quiet) this.emit('message', { text: 'Port open — waiting for the dial to answer', tone: 'info' });
        this._timer = setInterval(() => this._usbTick(), 250);
        this._usbTick();
        this._readUsb(port).catch(() => {}).finally(() => { if (this.port === port) this._lost(); });
        return true;
    }

    async _readUsb(port) {
        const frames = new FrameReader();
        while (this.port === port && port.readable) {
            this._reader = port.readable.getReader();
            try {
                for (;;) {
                    const { value, done } = await this._reader.read();
                    if (done) return;
                    for (const f of frames.push(value)) this._usbFrame(f);
                }
            } finally {
                try { this._reader.releaseLock(); } catch (e) { /* gone */ }
                this._reader = null;
            }
        }
    }

    _usbFrame({ type, payload }) {
        this._lastHeard = performance.now();
        if (type === FRAME.HELLO) {
            const name = new TextDecoder().decode(payload.subarray(1)) || 'UberSDR Dial';
            if (!this.connected) {
                this.deviceName = name;
                this.connected = true;
                this.waiting = false;
                this._resetLink();
                this.emit('state', { connected: true });
                this.emit('message', { text: `${this.deviceName} connected over USB`, tone: 'good' });
            }
        } else if (type === FRAME.INPUT && this.connected) {
            this._input(payload);
        }
    }

    // Hello once a second; and a dial that has gone quiet (switched off, or
    // restarted into another mode) is waited for again, the port left open.
    // Called from setState and setSpectrum too: a tab in the background has
    // its timers slowed to once a second or less, its spectrum frames not.
    _usbTick() {
        if (!this.port) return;
        const now = performance.now();
        if (this.connected && now - this._lastHeard > SILENT_MS) {
            this.connected = false;
            this.waiting = true;
            this.emit('state', { connected: false, waiting: true });
            this.emit('message', { text: 'The dial stopped answering — waiting for it', tone: 'warn' });
        }
        if (now - this._lastHello >= HELLO_MS) {
            this._lastHello = now;
            this._usbWrite(FRAME.HELLO, Uint8Array.of(1)).catch(() => {});
            // A damaged frame is dropped, not resent, and the name goes out
            // once: lose it and the dial's header says "connected" for good.
            // So the name and the latest state ride along with every hello —
            // a few dozen bytes a second, and any loss heals within one.
            if (this.connected) {
                if (this._usbName) this._usbWrite(FRAME.NAME, this._usbName).catch(() => {});
                if (this._usbState && !this._stateQueued) this._usbWrite(FRAME.STATE, this._usbState).catch(() => {});
            }
        }
    }

    _usbWrite(type, payload) {
        const w = this._writer;
        return w ? w.write(encodeFrame(type, payload)) : Promise.resolve();
    }

    async disconnect() {
        if (this.device) {
            this.device.removeEventListener('gattserverdisconnected', this._onDisconnect);
            try { this.device.gatt.disconnect(); } catch (e) { /* already gone */ }
        }
        this.device = null;
        this.stateChar = null;
        this.nameChar = null;
        this.specChar = null;
        const port = this.port;
        if (port) {
            this.port = null;
            clearInterval(this._timer);
            this._timer = null;
            const w = this._writer;
            this._writer = null;
            if (w) {
                // Tells the dial straight away rather than after its timeout.
                try { await w.write(encodeFrame(FRAME.BYE)); } catch (e) { /* gone */ }
                try { w.releaseLock(); } catch (e) { /* gone */ }
            }
            // The reader must let go before the port can close, or the next
            // open finds it still locked.
            if (this._reader) { try { await this._reader.cancel(); } catch (e) { /* gone */ } }
            try { await port.close(); } catch (e) { /* already gone */ }
        }
        const was = this.connected || this.waiting;
        this.connected = false;
        this.waiting = false;
        if (was) {
            this.emit('state', { connected: false });
            this.emit('message', { text: 'Disconnected', tone: 'info' });
        }
    }

    _lost() {
        this.device = null;
        this.stateChar = null;
        this.nameChar = null;
        this.specChar = null;
        if (this.port) {
            const port = this.port;
            this.port = null;
            clearInterval(this._timer);
            this._timer = null;
            try { if (this._writer) this._writer.releaseLock(); } catch (e) { /* gone */ }
            this._writer = null;
            port.close().catch(() => {});
        }
        const was = this.connected || this.waiting;
        const wasConnected = this.connected;
        this.connected = false;
        this.waiting = false;
        if (!was) return;
        this.emit('state', { connected: false });
        this.emit('message', { text: wasConnected ? 'Dial disconnected' : 'The port closed', tone: 'warn' });
    }

    /**
     * Push the receiver's state to the dial. Only what changed goes out, and
     * GATT allows one operation at a time, so a write in flight holds the
     * newest state back rather than queueing every intermediate one.
     */
    setState(s) {
        if (this.port) this._usbTick();
        if (!this.connected || !(this.stateChar || this.port)) return;
        const bytes = encodeState(s);
        const sig = bytes.join(',');
        if (sig === this._lastState) return;
        this._lastState = sig;
        this._pending = bytes;
        if (this._stateQueued) return;  // the queued write will take the newest
        this._stateQueued = true;
        this._enqueue(async () => {
            this._stateQueued = false;
            const b = this._pending;
            this._pending = null;
            if (!b) return;
            if (this.port) { this._usbState = b; await this._usbWrite(FRAME.STATE, b); }
            else if (this.stateChar) await this.stateChar.writeValueWithResponse(b);
        });
    }

    _enqueue(op) {
        const run = this._chain.then(op);
        // A failed write is replaced by the next one a moment later; it must
        // not wedge the chain.
        this._chain = run.catch(() => {});
        return run;
    }

    /**
     * One spectrum line for the dial's waterfall background. Dropped rather
     * than queued while the last one is still going out: the next frame is
     * newer anyway, and the state record must never wait behind a backlog.
     */
    setSpectrum(bins, centerHz, spanHz) {
        if (this.port) this._usbTick();
        if (!this.connected || !(this.specChar || this.port) || this._specBusy || !bins || !bins.length) return;
        this._specBusy = true;
        const usb = !!this.port;
        const packets = encodeSpectrum(bins, centerHz, spanHz, this._specSeq++, usb ? SPEC_POINTS : this._specChunk);
        this._enqueue(async () => {
            for (const p of packets) {
                if (usb) await this._usbWrite(FRAME.SPEC, p);
                else if (this.specChar) await this.specChar.writeValueWithResponse(p);
            }
        }).catch(() => {
            // A link that won't take a 172-byte write: fall back to pieces that
            // fit the smallest one, from the next line on.
            if (!usb && this._specChunk !== 8) this._specChunk = 8;
        }).finally(() => { this._specBusy = false; });
    }

    /** The receiver's name, shown on the dial. */
    setName(name) {
        if (!this.connected || !(this.nameChar || this.port)) return;
        const bytes = new TextEncoder().encode(String(name || '')).slice(0, 32);
        this._enqueue(async () => {
            if (this.port) { this._usbName = bytes; await this._usbWrite(FRAME.NAME, bytes); }
            else if (this.nameChar) await this.nameChar.writeValueWithResponse(bytes);
        }).catch(() => {});
    }
}
