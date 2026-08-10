'use strict';

// TCI — Expert Electronics' transceiver control protocol.
//
// Unlike flrig and rigctld, this one runs in the receiver window rather than in
// the main process: TCI is carried over a WebSocket, the main process has none
// (Electron 34 is on Node 20, which predates the global), and hand-rolling
// RFC 6455 to reach a protocol that asked to be implemented precisely is
// exactly the wrong trade. The renderer has a correct WebSocket already, and
// nothing forbids it opening one to localhost. So this file is browser code,
// bundled into receiver-preload.js.
//
// ── The protocol ──────────────────────────────────────────────────────────
//
// Text frames, each carrying one or more commands. A command is
//
//     name:arg1,arg2,…;      or, with no arguments,      name;
//
// and one frame may hold several, so a frame is split on ';' rather than
// assumed to be a single command.
//
// The server opens by describing itself and then says it is ready. In the order
// clients/python/tci_server.py sends them:
//
//     device:<name>;  protocol:<version>;  trx_count:<n>;
//     vfo_limits:<min>,<max>;  if_limits:<low>,<high>;
//     modulations_list:am,sam,dsb,lsb,usb,cw,nfm,wfm,digl,digu,spec,drm;
//     audio_samplerate:<hz>;  iq_samplerate:<hz>;
//     …per receiver: rx_enable, dds, vfo (per VFO), modulation, split_enable, trx…
//     ready;
//
// Nothing is sent by the client during the handshake — notably not `start;`,
// which is the *power* command and would switch a transceiver on.
//
// Afterwards the same messages arrive unsolicited whenever the radio changes,
// and the two worth acting on are:
//
//     vfo:<rx>,<vfo>,<hz>       the tuned frequency
//     modulation:<rx>,<mode>    the mode
//     trx:<rx>,<true|false>     PTT
//
// `dds` is deliberately *not* treated as the frequency, though the Python
// client does: dds is the panorama's centre and vfo is where the receiver is
// listening. Dragging the panorama on a SunSDR moves the former and not the
// latter, and following it would drag this receiver off frequency for a gesture
// that never retuned anything.
//
// Receiver 0, VFO 0. TCI addresses several of each; this follows the first,
// which is the one a single-receiver sync means.

const DEFAULT_PORT = 40001;

// How long to wait for `ready;`. The handshake is a dozen small frames over a
// local socket; anything slower than this is not a TCI server.
const READY_MS = 5000;

// TCI's modulation names against v2's. `cw` has no sideband in TCI, so it reads
// as CW-upper and both of v2's CW modes write back to it.
//
// dsb, digl, digu, spec and drm are absent on purpose: they are read and shown
// as whatever the radio called them, but never mapped, so nothing tries to put
// this receiver into a mode it has no equivalent for — the rule flrig.js and
// rigctl.js already follow.
const TCI_TO_SDR = {
    usb: 'usb', lsb: 'lsb',
    cw: 'cwu',
    am: 'am', sam: 'sam',
    nfm: 'nfm', wfm: 'fm',
};
const SDR_TO_TCI = {
    usb: 'usb', lsb: 'lsb',
    cwu: 'cw', cwl: 'cw',
    am: 'am', sam: 'sam',
    nfm: 'nfm', fm: 'wfm',
};

/**
 * Splits a frame into its commands.
 *
 * Exported because it is the whole of the wire format and worth pinning by
 * test: a frame may carry several commands, arguments are comma-separated, and
 * a command may have none at all.
 */
function parseFrame(text) {
    const out = [];
    for (const part of String(text).split(';')) {
        const cmd = part.trim();
        if (!cmd) continue;
        const at = cmd.indexOf(':');
        if (at < 0) out.push({ name: cmd.toLowerCase(), args: [] });
        else {
            out.push({
                name: cmd.slice(0, at).trim().toLowerCase(),
                args: cmd.slice(at + 1).split(',').map((a) => a.trim()),
            });
        }
    }
    return out;
}

/** One live link to a TCI radio. Same surface as FlrigLink and RigctlLink. */
class TciLink {
    constructor({ host, port, onState }) {
        this.host = host || '127.0.0.1';
        this.port = Number(port) || DEFAULT_PORT;
        this.onState = onState;
        this.ws = null;
        this.stopped = false;
        this.failing = false;
        this.retry = null;
        this.readyTimer = null;

        // What the radio has told us. Reported as one state whenever any of it
        // changes, because the panel wants a picture rather than a diff.
        this.frequency = null;
        this.mode = null;
        this.tx = false;
        this.ready = false;
        // The modulations this radio admits to. A mode outside the list is
        // never sent: TCI has no reply to a command, so an unsupported one is
        // silently ignored, and knowing beforehand is the only way to avoid it.
        this.modulations = null;
    }

    start() {
        this.open();
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.retry);
        clearTimeout(this.readyTimer);
        this.retry = null;
        const ws = this.ws;
        this.ws = null;
        if (ws) {
            ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
            try { ws.close(); } catch (e) { /* already gone */ }
        }
    }

    open() {
        if (this.stopped || this.ws) return;
        let ws;
        try {
            ws = new WebSocket(`ws://${this.host}:${this.port}`);
        } catch (e) {
            this.fail(e.message || 'bad address');
            return;
        }
        this.ws = ws;
        // Binary frames are audio and IQ, which this has no use for. Asking for
        // arraybuffer rather than the default Blob keeps them cheap to discard.
        ws.binaryType = 'arraybuffer';

        // `ready;` is the end of the handshake. A socket that opens and then
        // says nothing is something else listening on the port, and saying so
        // beats waiting for ever.
        this.readyTimer = setTimeout(() => {
            if (!this.ready) this.fail('no TCI handshake — is that a TCI server?');
        }, READY_MS);

        ws.onmessage = (event) => {
            if (typeof event.data !== 'string') return;   // audio/IQ
            this.onFrame(event.data);
        };
        ws.onerror = () => { /* close follows, and carries the outcome */ };
        ws.onclose = () => {
            if (this.stopped || this.ws !== ws) return;
            this.fail(this.ready ? 'connection closed' : 'could not connect');
        };
    }

    fail(message) {
        clearTimeout(this.readyTimer);
        const ws = this.ws;
        this.ws = null;
        this.ready = false;
        if (ws) {
            ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
            try { ws.close(); } catch (e) { /* already gone */ }
        }
        // Once per spell of failure, as the other links do.
        if (!this.failing) {
            this.failing = true;
            this.onState({ connected: false, tx: false, error: `TCI: ${message}` });
        }
        // Retried at human speed: what is being waited for is a radio being
        // switched on, or an address being corrected.
        if (!this.stopped && !this.retry) {
            this.retry = setTimeout(() => { this.retry = null; this.open(); }, 1000);
        }
    }

    onFrame(text) {
        let changed = false;
        for (const { name, args } of parseFrame(text)) {
            switch (name) {
                case 'modulations_list':
                    this.modulations = new Set(args.map((m) => m.toLowerCase()));
                    break;
                case 'vfo':
                    // vfo:<rx>,<vfo>,<hz> — the first receiver's first VFO.
                    if (args.length >= 3 && args[0] === '0' && args[1] === '0') {
                        const hz = parseInt(args[2], 10);
                        if (Number.isFinite(hz) && hz !== this.frequency) {
                            this.frequency = hz;
                            changed = true;
                        }
                    }
                    break;
                case 'modulation':
                    if (args.length >= 2 && args[0] === '0') {
                        const mode = args[1].toLowerCase();
                        if (mode !== this.mode) { this.mode = mode; changed = true; }
                    }
                    break;
                case 'trx': {
                    // trx:<rx>,<true|false>[,<source>] — the third argument says
                    // what keyed it, and is not ours to care about.
                    if (args.length >= 2 && args[0] === '0') {
                        const tx = args[1].toLowerCase() === 'true';
                        if (tx !== this.tx) { this.tx = tx; changed = true; }
                    }
                    break;
                }
                case 'ready':
                    clearTimeout(this.readyTimer);
                    this.ready = true;
                    this.failing = false;
                    changed = true;
                    break;
                default:
                    break;      // device, protocol, limits, sample rates, …
            }
        }
        if (changed && this.ready) this.report();
    }

    report() {
        this.onState({
            connected: true,
            error: null,
            frequency: this.frequency,
            mode: this.mode ? this.mode.toUpperCase() : null,
            sdrMode: this.mode ? (TCI_TO_SDR[this.mode] || null) : null,
            tx: this.tx,
        });
    }

    send(command) {
        if (!this.ws || this.ws.readyState !== 1) return false;
        this.ws.send(command);
        return true;
    }

    setFrequency(hz) {
        // Receiver 0, VFO 0 — the one being followed.
        this.send(`vfo:0,0,${Math.round(Number(hz))};`);
        return Promise.resolve(true);
    }

    setMode(sdrMode) {
        const mode = SDR_TO_TCI[sdrMode];
        if (!mode) return Promise.resolve(false);
        // Refused quietly by the radio if it has no such modulation, and TCI
        // has no way to say so — hence the list from the handshake.
        if (this.modulations && !this.modulations.has(mode)) return Promise.resolve(false);
        this.send(`modulation:0,${mode};`);
        return Promise.resolve(true);
    }
}

module.exports = { TciLink, parseFrame, TCI_TO_SDR, SDR_TO_TCI, DEFAULT_PORT };
