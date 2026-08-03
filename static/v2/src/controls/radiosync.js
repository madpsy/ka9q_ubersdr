// Radio Sync — full CAT control of a real transceiver, keeping it and the SDR
// on the same frequency and mode.
//
// The rig backends are Hamlib itself, compiled to WebAssembly and served from
// /hamlib/, talking to the hardware through the Web Serial API. That is why
// every serial-capable rig Hamlib knows about works here rather than a handful
// with hand-written protocol parsers.
//
// **The module is 14 MB and is never fetched until someone chooses this
// source.** `ensureLoaded()` is the only thing that pulls it, it caches the
// promise so the fetch happens once, and it deliberately does not cache a
// rejection — a transient failure on a 14 MB download must not leave the panel
// permanently dead until a page reload.

import { Emitter } from '../radio/emitter.js';
import { loadScript } from '../lib/loadScript.js';

const BASE = '/hamlib';

// Hamlib reports a failed call as a negative return code rather than throwing,
// so a dead port would otherwise be polled — and logged — forever at 10 Hz.
const MAX_POLL_FAILURES = 20;
const POLL_MS = 100;

// The SDR's mode names against Hamlib's canonical rig_strrmode() names. One
// table for both directions.
export const SDR_TO_HAMLIB = {
    usb: 'USB', lsb: 'LSB', cwu: 'CW', cwl: 'CWR',
    am: 'AM', sam: 'SAM', fm: 'FM', nfm: 'FMN',
};
const HAMLIB_TO_SDR = Object.fromEntries(Object.entries(SDR_TO_HAMLIB).map(([a, b]) => [b, a]));

export function serialAvailable() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
}

export class RadioSync extends Emitter {
    constructor() {
        super();
        this.module = null;
        this.loadPromise = null;
        this.rigs = [];
        this.handle = 0;
        this.connected = false;
        this.busy = false;          // a connect or disconnect is in flight
        this.direction = 'sdr-to-radio';
        this.muteOnTx = true;

        this.timer = null;
        this.polling = false;       // a poll cycle is still in the air
        this.failures = 0;

        // What the rig last told us, for the readout.
        this.rig = { frequency: 0, mode: '---', tx: false };
        // What we last pushed, so a value we caused is not pushed back.
        this.lastSent = { frequency: 0, mode: '' };
        this.wasMutedBeforeTx = false;

        this.ctx = null;            // radio facade, set by the panel
    }

    setContext(ctx) {
        this.ctx = ctx;
    }

    // Fetches and instantiates the wasm module, once. Resolves to the rig list.
    ensureLoaded() {
        if (this.loadPromise) return this.loadPromise;

        this.loadPromise = (async () => {
            this.emit('loading', { loading: true });
            await loadScript(`${BASE}/hamlib-serial-bridge.js`);

            // Assembled at runtime so the bundler leaves it alone: this module
            // is served from /hamlib/ and must never be pulled into v2.js.
            const url = `${BASE}/hamlib.js`;
            const mod = await import(url);
            const createHamlibModule = mod.default;

            const bridge = new window.HamlibSerialBridge();
            const Module = await createHamlibModule({ hamlibSerial: bridge });
            this.module = Module;

            // hamlib.wasm is built with plain -sASYNCIFY, which allows only one
            // in-flight async call into the module: starting a second before the
            // first has unwound corrupts Asyncify's stack and Hamlib's shared
            // command/response buffers, which shows up as nonsense like PTT
            // flipping at random. The poll loop can overlap a set_freq on a slow
            // serial link, so every call goes through one queue.
            let queue = Promise.resolve();
            const serialize = (fn) => (...args) => {
                const result = queue.then(() => fn(...args));
                queue = result.then(() => {}, () => {});
                return result;
            };

            this.open = serialize(Module.cwrap('hamlib_open', 'number',
                ['number', 'number', 'number', 'number', 'number', 'number'], { async: true }));
            this.closeRig = serialize(Module.cwrap('hamlib_close', 'number', ['number'], { async: true }));
            this.getFreq = serialize(Module.cwrap('hamlib_get_freq', 'number', ['number'], { async: true }));
            this.setFreq = serialize(Module.cwrap('hamlib_set_freq', 'number', ['number', 'number'], { async: true }));
            this.getMode = serialize(Module.cwrap('hamlib_get_mode', 'string', ['number'], { async: true }));
            this.setMode = serialize(Module.cwrap('hamlib_set_mode', 'number', ['number', 'string'], { async: true }));
            this.getPtt = serialize(Module.cwrap('hamlib_get_ptt', 'number', ['number'], { async: true }));

            // No I/O, so this one is a plain synchronous call.
            this.rigs = JSON.parse(Module.cwrap('hamlib_list_rigs', 'string', [])());
            this.emit('loading', { loading: false });
            this.emit('rigs', this.rigs);
            this.emit('message', { text: `Hamlib loaded — ${this.rigs.length} rig models`, tone: 'good' });
            return this.rigs;
        })();

        this.loadPromise.catch((err) => {
            this.loadPromise = null;
            this.emit('loading', { loading: false });
            this.emit('message', { text: `Could not load Hamlib: ${err.message}`, tone: 'error' });
        });

        return this.loadPromise;
    }

    // Rig models grouped by manufacturer, for the picker.
    byManufacturer() {
        const groups = new Map();
        for (const rig of this.rigs) {
            if (!groups.has(rig.mfg)) groups.set(rig.mfg, []);
            groups.get(rig.mfg).push(rig);
        }
        return Array.from(groups.entries())
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([mfg, rigs]) => [mfg, rigs.sort((a, b) => a.name.localeCompare(b.name))]);
    }

    rigByModel(model) {
        return this.rigs.find((r) => String(r.model) === String(model)) || null;
    }

    // `baud` of 0 means "whatever the rig's own maximum is".
    async connect(model, baud) {
        if (this.connected || this.busy) return false;
        if (!serialAvailable()) {
            this.emit('message', { text: 'This browser has no Web Serial API — try Chrome or Edge.', tone: 'error' });
            return false;
        }
        try {
            await this.ensureLoaded();
        } catch (err) {
            return false;   // ensureLoaded already reported it
        }
        const rig = this.rigByModel(model);
        if (!rig) {
            this.emit('message', { text: 'Choose a radio model first', tone: 'warn' });
            return false;
        }

        this.busy = true;
        this.emit('state', this.snapshot());
        try {
            this.emit('message', { text: `Connecting to ${rig.mfg} ${rig.name}…`, tone: 'info' });
            // This is what raises the browser's serial port picker, so it has to
            // stay on the stack of the click that called connect().
            this.handle = await this.open(
                Number(model), baud || Number(rig.baudMax),
                Number(rig.dataBits), Number(rig.stopBits), Number(rig.parity), Number(rig.handshake),
            );
            if (this.handle <= 0) throw new Error('hamlib_open failed — see the browser console for its debug trace');

            this.connected = true;
            this.failures = 0;
            this.emit('message', { text: `Connected to ${rig.mfg} ${rig.name}`, tone: 'good' });

            // Push the SDR's current state at the rig so the two start together
            // rather than waiting for the operator to touch something.
            if (this.direction === 'sdr-to-radio' && this.ctx) {
                const t = this.ctx.state().tuning;
                await this._pushFrequency(t.frequency);
                await this._pushMode(t.mode);
            }
            this._startPolling();
        } catch (err) {
            this.emit('message', { text: `Connection failed: ${err.message}`, tone: 'error' });
            this.handle = 0;
            this.connected = false;
        } finally {
            this.busy = false;
            this.emit('state', this.snapshot());
        }
        return this.connected;
    }

    async disconnect() {
        if (!this.handle || this.busy) return;
        this.busy = true;
        this._stopPolling();
        try {
            await this.closeRig(this.handle);
            this.emit('message', { text: 'Disconnected from radio', tone: 'info' });
        } catch (err) {
            this.emit('message', { text: `Disconnect error: ${err.message}`, tone: 'error' });
        } finally {
            // Unmute before letting go: leaving the receiver muted because the
            // rig happened to be transmitting when the link dropped is a fault
            // report waiting to happen.
            this._endTx();
            this.handle = 0;
            this.connected = false;
            this.busy = false;
            this.rig = { frequency: 0, mode: '---', tx: false };
            this.emit('state', this.snapshot());
        }
    }

    setDirection(direction) {
        this.direction = direction;
        // Re-arm the comparison so switching direction does not immediately
        // push a stale value in the new one.
        if (this.ctx) {
            const t = this.ctx.state().tuning;
            this.lastSent = { frequency: t.frequency, mode: t.mode };
        }
        this.emit('state', this.snapshot());
    }

    setMuteOnTx(on) {
        this.muteOnTx = on;
        if (!on) this._endTx();
        this.emit('state', this.snapshot());
    }

    snapshot() {
        return {
            connected: this.connected,
            busy: this.busy,
            direction: this.direction,
            muteOnTx: this.muteOnTx,
            rig: { ...this.rig },
        };
    }

    // --- the 10 Hz loop -----------------------------------------------------

    _startPolling() {
        this._stopPolling();
        this.polling = false;
        this.failures = 0;
        this.timer = setInterval(() => this._tick(), POLL_MS);
    }

    _stopPolling() {
        clearInterval(this.timer);
        this.timer = null;
    }

    // Skips a tick rather than queueing another cycle when the previous one is
    // still running: real serial hardware does not promise to answer three
    // requests inside 100 ms, and piling them up would grow an unbounded
    // backlog behind the serialising queue.
    async _tick() {
        if (!this.connected || !this.handle || this.polling) return;
        this.polling = true;
        try {
            const freq = await this.getFreq(this.handle);
            const mode = await this.getMode(this.handle);
            const ptt = await this.getPtt(this.handle);

            if (freq >= 0) this._onRigFrequency(freq);
            if (mode) this._onRigMode(mode);
            if (ptt >= 0) this._onPtt(ptt !== 0);

            if (freq < 0 && !mode && ptt < 0) this.failures += 1;
            else this.failures = 0;

            if (this.direction === 'sdr-to-radio') await this._pushFromSdr();
        } catch (err) {
            this.failures += 1;
        } finally {
            this.polling = false;
        }

        if (this.failures >= MAX_POLL_FAILURES) {
            this.emit('message', { text: `Lost contact with the radio after ${this.failures} failed polls — disconnecting`, tone: 'error' });
            this.disconnect();
        }
    }

    _onRigFrequency(freq) {
        if (this.rig.frequency !== freq) {
            this.rig = { ...this.rig, frequency: freq };
            this.emit('state', this.snapshot());
        }
        if (this.direction !== 'radio-to-sdr' || !this.ctx) return;
        if (freq === this.ctx.state().tuning.frequency) return;
        this.lastSent.frequency = freq;
        this.ctx.actions.setFrequency(freq);
    }

    _onRigMode(hamlibMode) {
        const sdrMode = HAMLIB_TO_SDR[hamlibMode];
        const shown = sdrMode || hamlibMode;
        if (this.rig.mode !== shown) {
            this.rig = { ...this.rig, mode: shown };
            this.emit('state', this.snapshot());
        }
        if (!this.ctx) return;

        // A rig sitting in a data mode — PKTUSB, RTTY, anything used for FT8 —
        // has no SDR equivalent. Show it, but leave both ends alone: pushing it
        // at the SDR fails, and recording it would make the next sdr-to-radio
        // comparison "correct" the rig out of data mode.
        if (!sdrMode) {
            this.lastSent.mode = this.ctx.state().tuning.mode;
            return;
        }
        if (this.direction !== 'radio-to-sdr') return;
        if (sdrMode === this.ctx.state().tuning.mode) return;
        this.lastSent.mode = sdrMode;
        this.ctx.actions.setMode(sdrMode);
    }

    _onPtt(tx) {
        if (this.rig.tx === tx) return;
        const wasTx = this.rig.tx;
        this.rig = { ...this.rig, tx };
        this.emit('state', this.snapshot());
        if (!this.muteOnTx) return;
        if (tx && !wasTx) this._beginTx();
        else if (!tx && wasTx) this._endTx();
    }

    // Muting on transmit remembers whether the receiver was already muted, so
    // dropping back to receive restores what the operator had rather than
    // unmuting something they had deliberately silenced.
    _beginTx() {
        if (!this.ctx) return;
        this.wasMutedBeforeTx = this.ctx.state().audio.muted;
        if (!this.wasMutedBeforeTx) this.ctx.actions.toggleMute();
    }

    _endTx() {
        if (!this.ctx || this.wasMutedBeforeTx) return;
        if (this.ctx.state().audio.muted) this.ctx.actions.toggleMute();
    }

    async _pushFromSdr() {
        if (!this.ctx) return;
        const t = this.ctx.state().tuning;
        if (t.frequency !== this.lastSent.frequency) {
            this.lastSent.frequency = t.frequency;
            await this._pushFrequency(t.frequency);
        }
        if (t.mode !== this.lastSent.mode) {
            this.lastSent.mode = t.mode;
            await this._pushMode(t.mode);
        }
    }

    async _pushFrequency(freq) {
        if (!this.connected && !this.handle) return;
        try {
            await this.setFreq(this.handle, freq);
        } catch (err) {
            this.emit('message', { text: `Could not set the radio's frequency: ${err.message}`, tone: 'error' });
        }
    }

    async _pushMode(mode) {
        if (!this.connected && !this.handle) return;
        try {
            await this.setMode(this.handle, SDR_TO_HAMLIB[mode] || mode.toUpperCase());
        } catch (err) {
            this.emit('message', { text: `Could not set the radio's mode: ${err.message}`, tone: 'error' });
        }
    }
}
