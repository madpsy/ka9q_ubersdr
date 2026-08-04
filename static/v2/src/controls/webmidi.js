// USB MIDI control surfaces, over the Web MIDI API. Chrome and Edge only —
// Firefox has never shipped it.
//
// Controls are keyed `type:channel:number`, where type is the status byte's
// high nibble: 0x90 note on, 0x80 note off, 0xB0 control change. Keeping the
// note-off address separate is what lets a button do one thing on press and
// another on release ("map both" in learn mode) — a momentary PTT-style toggle
// needs exactly that.
//
// A CC's value decides how it is presented to the function catalogue:
//
//   * a fader or pot sends 0..127 across its travel      → absolute
//   * an endless encoder sends 1..63 up, 65..127 down    → relative
//
// The two are indistinguishable from a single message, so the mapping records
// which one the control is and the operator can flip it. Guessing wrong is
// obvious the moment you turn the knob, and a wrong guess on a fader would slew
// the radio across the band.

import { Emitter } from '../radio/emitter.js';

export const NOTE_ON = 0x90;
export const NOTE_OFF = 0x80;
export const CC = 0xb0;

export function midiAvailable() {
    return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
}

export function midiKey(type, channel, number) {
    return `${type}:${channel}:${number}`;
}

export function isCCKey(key) {
    return String(key).startsWith(`${CC}:`);
}

export function midiKeyLabel(key) {
    const [type, channel, number] = String(key).split(':').map(Number);
    const ch = Number.isFinite(channel) ? channel + 1 : '?';
    if (type === CC) return `CC ${number} · ch ${ch}`;
    if (type === NOTE_ON) return `Note ${number} on · ch ${ch}`;
    if (type === NOTE_OFF) return `Note ${number} off · ch ${ch}`;
    return key;
}

// Relative encoders use two's-complement-ish halves around 64.
function relativeDelta(value) {
    return value >= 64 ? value - 128 : value;
}

export class MIDIControl extends Emitter {
    constructor() {
        super();
        this.access = null;
        this.input = null;
        this.connected = false;
        this.deviceId = null;
        this.deviceName = '';
        // Keyed by mapping key: true when that control is an endless encoder.
        this.relative = {};
    }

    setRelative(map) {
        this.relative = map || {};
    }

    // Asks for access without SysEx — nothing here needs it, and requesting it
    // turns a silent grant into a permission prompt.
    async open() {
        if (!midiAvailable()) {
            this.emit('message', { text: 'This browser has no Web MIDI API — try Chrome or Edge.', tone: 'error' });
            return false;
        }
        try {
            this.access = await navigator.requestMIDIAccess({ sysex: false });
        } catch (err) {
            this.emit('message', { text: `MIDI access refused: ${err.message}`, tone: 'error' });
            return false;
        }
        // Devices come and go while the panel is open; the list must follow.
        this.access.onstatechange = () => this.emit('devices', this.devices());
        this.emit('devices', this.devices());
        return true;
    }

    devices() {
        if (!this.access) return [];
        return Array.from(this.access.inputs.values()).map((i) => ({ id: i.id, name: i.name || i.id }));
    }

    connect(id) {
        if (!this.access) return false;
        const input = this.access.inputs.get(id);
        if (!input) {
            this.emit('message', { text: 'That MIDI device is no longer attached', tone: 'error' });
            return false;
        }
        this.disconnect(true);
        this.input = input;
        this.input.onmidimessage = (msg) => this._onMessage(msg);
        this.connected = true;
        this.deviceId = id;
        this.deviceName = input.name || id;
        this.emit('state', { connected: true, deviceName: this.deviceName });
        this.emit('message', { text: `Connected: ${this.deviceName}`, tone: 'good' });
        return true;
    }

    disconnect(quiet) {
        if (this.input) {
            this.input.onmidimessage = null;
            this.input = null;
        }
        if (!this.connected) return;
        this.connected = false;
        this.deviceId = null;
        this.deviceName = '';
        this.emit('state', { connected: false, deviceName: '' });
        if (!quiet) this.emit('message', { text: 'Disconnected', tone: 'info' });
    }

    close() {
        this.disconnect(true);
        if (this.access) this.access.onstatechange = null;
        this.access = null;
    }

    _onMessage(msg) {
        if (!msg.data || msg.data.length < 2) return;
        const [status, number, value = 0] = msg.data;
        const type = status & 0xf0;
        const channel = status & 0x0f;

        // Note-on with velocity 0 is note-off on most hardware.
        const isNoteOn = type === NOTE_ON && value > 0;
        const isNoteOff = type === NOTE_OFF || (type === NOTE_ON && value === 0);
        const isCC = type === CC;
        if (!isNoteOn && !isNoteOff && !isCC) return;

        const key = midiKey(isNoteOff ? NOTE_OFF : type, channel, number);

        let event;
        if (isCC) {
            event = this.relative[key]
                ? { kind: 'relative', delta: relativeDelta(value) }
                : { kind: 'absolute', value: value / 127 };
        } else {
            event = { kind: 'trigger' };
        }

        this.emit('input', { key, event, isNoteOn, isNoteOff, isCC, value });
    }
}
