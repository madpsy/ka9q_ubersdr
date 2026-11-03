// UberSDR Dial — the round ESP32-S3 knob display (github: ubersdr_controller),
// in its Bluetooth controller mode, read over Web Bluetooth.
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
//          code 1..5   knob turned on page tune/volume/zoom/squelch/bandwidth,
//                      value = signed detents (+ clockwise)
//          code 16..21 mode tap/hold, freq tap/hold, mute tap/hold (value 1)
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
//
// The same table lives in the dial's firmware (docs/BLE_PROTOCOL.md there);
// change both together.

import { Emitter } from '../radio/emitter.js';
import { MODES } from '../radio/constants.js';

export const DIAL_SERVICE = '89540001-8c77-4d5f-9411-e7534b50c873';
export const DIAL_INPUT = '89540002-8c77-4d5f-9411-e7534b50c873';
export const DIAL_STATE = '89540003-8c77-4d5f-9411-e7534b50c873';
export const DIAL_NAME = '89540004-8c77-4d5f-9411-e7534b50c873';
export const STATE_BYTES = 20;

// Mode index sent in the state. The v2 mode table's order, IQ included, so the
// dial can name whatever mode the receiver is in.
export const DIAL_MODES = MODES.map((m) => m.id);

const PAGES = { 1: 'tune', 2: 'vol', 3: 'zoom', 4: 'sql', 5: 'bw' };
const BUTTONS = {
    16: 'mode_tap', 17: 'mode_hold', 18: 'freq_tap', 19: 'freq_hold', 20: 'mute_tap', 21: 'mute_hold',
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
    { key: 'mode_tap', label: 'Mode — tap' },
    { key: 'mode_hold', label: 'Mode — hold' },
    { key: 'freq_tap', label: 'Frequency — tap' },
    { key: 'freq_hold', label: 'Frequency — hold' },
    { key: 'mute_tap', label: 'Mute — tap' },
    { key: 'mute_hold', label: 'Mute — hold' },
];

const KEY_LABEL = Object.fromEntries(DIAL_KEYS.map((k) => [k.key, k.label]));

export function dialKeyLabel(key) {
    return KEY_LABEL[key] || key;
}

const m = (fn) => ({ function: fn, throttleMs: 0, mode: 'none' });

// Arrives mapped, like the RC-28: every page of the knob does what its label on
// the dial says. A saved table wins, as for every surface.
export const DIAL_DEFAULT_MAPPINGS = {
    tune_up: m('freq_step_up'),
    tune_down: m('freq_step_down'),
    vol_up: m('volume_up'),
    vol_down: m('volume_down'),
    zoom_up: m('zoom_dial'),
    zoom_down: m('zoom_dial'),
    sql_up: m('squelch_set'),
    sql_down: m('squelch_set'),
    bw_up: m('bw_widen'),
    bw_down: m('bw_narrow'),
    mode_tap: m('mode_next'),
    mode_hold: m('mode_prev'),
    freq_tap: m('spectrum_center'),
    mute_tap: m('mute_toggle'),
};

export function dialAvailable() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

/** One notification as `[{ key, event }]` — one entry per detent or press. */
export function parseInput(bytes) {
    const out = [];
    for (let i = 0; i + 1 < bytes.length; i += 2) {
        const code = bytes[i];
        const value = bytes[i + 1] > 127 ? bytes[i + 1] - 256 : bytes[i + 1];
        if (PAGES[code] && value) {
            // One event per detent: the catalogue's press-type functions
            // (step, volume, bandwidth) act once per event, whatever its size.
            const key = `${PAGES[code]}_${value > 0 ? 'up' : 'down'}`;
            const one = value > 0 ? 1 : -1;
            for (let n = 0; n < Math.abs(value); n += 1) out.push({ key, event: { kind: 'relative', delta: one } });
        } else if (BUTTONS[code]) {
            out.push({ key: BUTTONS[code], event: { kind: 'trigger' } });
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

export class DialControl extends Emitter {
    constructor() {
        super();
        this.device = null;
        this.stateChar = null;
        this.nameChar = null;
        this.connected = false;
        this.deviceName = '';
        this._lastState = '';
        this._writing = false;
        this._pending = null;
        this._onDisconnect = () => this._lost();
    }

    // Must be called from a user gesture — the device chooser is gated on one.
    async connect() {
        if (!dialAvailable()) {
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

    // Reopens a dial this origin was already allowed to use. getDevices() is
    // only there with Chrome's persistent-permissions support; without it this
    // quietly does nothing and Connect is a click away.
    async autoConnect() {
        if (!dialAvailable() || this.connected || !navigator.bluetooth.getDevices) return false;
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

    async _start(device, quiet) {
        try {
            const server = await device.gatt.connect();
            const service = await server.getPrimaryService(DIAL_SERVICE);
            const input = await service.getCharacteristic(DIAL_INPUT);
            this.stateChar = await service.getCharacteristic(DIAL_STATE);
            this.nameChar = await service.getCharacteristic(DIAL_NAME).catch(() => null);
            input.addEventListener('characteristicvaluechanged', (e) => {
                const bytes = new Uint8Array(e.target.value.buffer);
                for (const ev of parseInput(bytes)) this.emit('input', ev);
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
        this._lastState = '';
        this.emit('state', { connected: true });
        this.emit('message', { text: `${this.deviceName} connected`, tone: 'good' });
        return true;
    }

    async disconnect() {
        if (this.device) {
            this.device.removeEventListener('gattserverdisconnected', this._onDisconnect);
            try { this.device.gatt.disconnect(); } catch (e) { /* already gone */ }
        }
        this.device = null;
        this.stateChar = null;
        this.nameChar = null;
        if (this.connected) {
            this.connected = false;
            this.emit('state', { connected: false });
            this.emit('message', { text: 'Disconnected', tone: 'info' });
        }
    }

    _lost() {
        this.device = null;
        this.stateChar = null;
        this.nameChar = null;
        if (!this.connected) return;
        this.connected = false;
        this.emit('state', { connected: false });
        this.emit('message', { text: 'Dial disconnected', tone: 'warn' });
    }

    /**
     * Push the receiver's state to the dial. Only what changed goes out, and
     * GATT allows one operation at a time, so a write in flight holds the
     * newest state back rather than queueing every intermediate one.
     */
    setState(s) {
        if (!this.connected || !this.stateChar) return;
        const bytes = encodeState(s);
        const sig = bytes.join(',');
        if (sig === this._lastState) return;
        this._lastState = sig;
        this._pending = bytes;
        this._flush();
    }

    /** The receiver's name, shown on the dial. */
    setName(name) {
        if (!this.connected || !this.nameChar) return;
        const bytes = new TextEncoder().encode(String(name || '')).slice(0, 32);
        this.nameChar.writeValueWithoutResponse(bytes).catch(() => {});
    }

    async _flush() {
        if (this._writing || !this._pending || !this.stateChar) return;
        this._writing = true;
        const bytes = this._pending;
        this._pending = null;
        try {
            await this.stateChar.writeValueWithoutResponse(bytes);
        } catch (err) {
            // A dropped write is replaced by the next state a moment later.
        } finally {
            this._writing = false;
            if (this._pending) this._flush();
        }
    }
}
