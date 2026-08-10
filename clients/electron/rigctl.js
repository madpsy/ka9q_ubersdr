'use strict';

// rigctld, over its TCP protocol.
//
// Hamlib's own daemon: whatever rig it is driving, it answers the same handful
// of one-letter commands on a socket. That makes it the widest radio support
// there is — every backend Hamlib has — reached without the 14 MB of
// WebAssembly the page's Serial transport needs, and without the cable being on
// this machine.
//
// Raw TCP, so it can only live in the main process; a page has no way to open a
// socket. Same arrangement as flrig.js, and it registers with the Radio Control
// panel through the same provider API — see receiver-preload.js.
//
// The protocol (Hamlib tests/rigctl_parse.c, doc/man1/rigctld.1):
//
//   f\n              → the frequency in Hz, on its own line
//   m\n              → the mode, then the passband width, on two lines
//   t\n              → 1 or 0 for PTT
//   F <hz>\n         → RPRT 0 on success, RPRT <negative> on failure
//   M <mode> <hz>\n  → likewise; 0 as the width means "the rig's own"
//
// The default protocol is used rather than the extended one: the replies are a
// value per line with no framing to speak of, and since each command here is
// sent and awaited in turn there is nothing to disambiguate.
//
// One connection, held open. rigctld hands each connection to a thread of its
// own and reads commands from it until the client goes away (handle_socket in
// tests/rigctld.c), so a connection per command is not merely wasteful — it is
// a thread created and destroyed in the daemon for every read, a hundred a
// second at the rate below.

const net = require('net');

// rigctld is normally on this machine or the next one, and answers from a rig
// over CAT. Long enough for a slow backend, short enough that a daemon which
// has gone away is noticed rather than waited on.
const TIMEOUT_MS = 4000;
const DEFAULT_PORT = 4532;

// The gap after a completed read, and after a failed one. Same reasoning as
// flrig.js: re-armed only once the previous cycle resolves, so reads can never
// overlap however slow the rig is, and a refused connection is retried at human
// speed rather than a thousand times a minute.
const POLL_GAP_MS = 25;
const RETRY_MS = 1000;

// Hamlib's mode tokens (src/misc.c) against v2's. The data modes are read but
// never written: the receiver has no equivalent, and pushing the nearest one
// would drag the rig out of the mode somebody put it in.
const RIGCTL_TO_SDR = {
    USB: 'usb', LSB: 'lsb',
    CW: 'cwu', CWR: 'cwl',
    AM: 'am', SAM: 'sam',
    FM: 'fm', FMN: 'nfm', WFM: 'fm',
};
const SDR_TO_RIGCTL = {
    usb: 'USB', lsb: 'LSB',
    cwu: 'CW', cwl: 'CWR',
    am: 'AM', sam: 'SAM',
    fm: 'FM', nfm: 'FMN',
};

/**
 * A reply, as the lines it is made of.
 *
 * Two shapes, and which one arrives is not something the request can predict:
 *
 *   * a `get` that worked answers with its values, one per line;
 *   * anything else answers `RPRT <code>` — 0 for a set that worked, negative
 *     for a refusal of either.
 *
 * So a reply is complete when it has the values asked for, *or* as soon as a
 * line starting RPRT arrives. Waiting for a fixed number of lines would hang
 * for ever on a `get` that failed, since the failure is one line where two
 * were expected.
 */
function takeReply(lines, wanted) {
    if (!lines.length) return null;
    if (/^RPRT\b/.test(lines[0])) {
        const code = parseInt(lines[0].slice(4).trim(), 10);
        // The code travels with the refusal, because what it says matters: a
        // rig that cannot report PTT (-11, RIG_ENAVAIL) is not a link that has
        // failed, and treating the two alike takes a working connection down.
        return { used: 1, rprt: code, error: code < 0 ? `RPRT ${code}` : null, values: [] };
    }
    if (lines.length < wanted) return null;
    return { used: wanted, rprt: null, error: null, values: lines.slice(0, wanted) };
}

/** One live link to rigctld: polls it, and does what it is told. */
class RigctlLink {
    constructor({ host, port, onState }) {
        this.host = host;
        this.port = Number(port) || DEFAULT_PORT;
        this.onState = onState;
        this.timer = null;
        this.stopped = false;
        this.failing = false;

        this.socket = null;
        this.buffer = '';
        // What has been sent and not yet answered. Commands go out one at a
        // time, so this holds one — but the protocol has no request ids, so a
        // queue is what makes "the reply belongs to the oldest command" a rule
        // rather than an assumption.
        this.pending = [];
        // Commands this rig has refused as unavailable. Plenty of backends
        // cannot read PTT, and asking every cycle is both pointless and — until
        // this existed — fatal to the link.
        this.unsupported = new Set();
    }

    start() {
        this.run();
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.timer);
        this.timer = null;
        this.drop(new Error('stopped'));
    }

    /** The connection has gone, or is being let go. */
    drop(err) {
        const socket = this.socket;
        this.socket = null;
        this.buffer = '';
        const waiting = this.pending;
        this.pending = [];
        for (const p of waiting) p.reject(err);
        if (socket) {
            socket.removeAllListeners();
            socket.destroy();
        }
    }

    connect() {
        if (this.socket) return Promise.resolve(this.socket);
        return new Promise((resolve, reject) => {
            const socket = net.createConnection({ host: this.host, port: this.port });
            socket.setNoDelay(true);
            const failed = (err) => {
                if (this.socket === socket) this.drop(err);
                else { socket.removeAllListeners(); socket.destroy(); }
                reject(err);
            };
            socket.once('error', failed);
            socket.setTimeout(TIMEOUT_MS, () => failed(new Error('rigctld did not answer')));
            socket.once('connect', () => {
                socket.removeListener('error', failed);
                this.socket = socket;
                socket.on('data', (chunk) => this.onData(chunk));
                socket.on('error', (err) => this.drop(err));
                socket.on('close', () => this.drop(new Error('rigctld closed the connection')));
                resolve(socket);
            });
        });
    }

    onData(chunk) {
        this.buffer += chunk.toString('utf8');
        for (;;) {
            const at = this.buffer.lastIndexOf('\n');
            if (at < 0) return;
            const lines = this.buffer.slice(0, at).split('\n').map((l) => l.trim()).filter((l) => l.length);
            if (!lines.length) { this.buffer = this.buffer.slice(at + 1); return; }

            const head = this.pending[0];
            // Nothing asked for it. Discarded rather than kept, so one stray
            // line cannot put every later reply one command out of step.
            if (!head) { this.buffer = ''; return; }

            const reply = takeReply(lines, head.lines);
            if (!reply) return;
            this.pending.shift();
            // Put back whatever belongs to the next command.
            this.buffer = lines.slice(reply.used).map((l) => l + '\n').join('')
                + this.buffer.slice(at + 1);
            if (reply.error) head.reject(Object.assign(new Error(reply.error), { rprt: reply.rprt }));
            else head.resolve(reply.values);
        }
    }

    /** Sends one command on the open connection, opening it if need be. */
    async send(command, lines = 1) {
        await this.connect();
        return new Promise((resolve, reject) => {
            this.pending.push({ lines, resolve, reject });
            this.socket.write(command + '\n', (err) => { if (err) this.drop(err); });
        });
    }

    async run() {
        if (this.stopped) return;
        const ok = await this.poll();
        if (this.stopped) return;
        this.timer = setTimeout(() => this.run(), ok ? POLL_GAP_MS : RETRY_MS);
    }

    /**
     * One read, tolerating a rig that cannot do it.
     *
     * A refusal (`RPRT <negative>`) is the rig answering, not the link
     * breaking: the connection is fine and everything else on it still works.
     * So the command is remembered as unavailable and not asked again, and the
     * value it would have carried is simply absent. Anything else — a closed
     * socket, a timeout — is a real failure and is left to the caller.
     */
    async read(command, lines = 1) {
        if (this.unsupported.has(command)) return null;
        try {
            return await this.send(command, lines);
        } catch (err) {
            if (err.rprt == null) throw err;
            this.unsupported.add(command);
            return null;
        }
    }

    async poll() {
        if (this.stopped) return false;
        try {
            const freq = await this.read('f');
            // Two lines: the mode, then the passband. Only the first is wanted,
            // but both have to be read or the next reply starts mid-stream.
            const mode = await this.read('m', 2);
            // Widely unsupported — a receiver-only backend has no PTT to report
            // — so its absence is a rig without one, not a rig transmitting.
            const ptt = await this.read('t');
            if (this.stopped) return false;
            this.failing = false;
            const token = String((mode && mode[0]) || '').toUpperCase();
            this.onState({
                connected: true,
                error: null,
                frequency: freq ? Math.round(parseFloat(freq[0])) || null : null,
                mode: token || null,
                sdrMode: RIGCTL_TO_SDR[token] || null,
                tx: ptt ? String(ptt[0]).trim() !== '0' : false,
                // Said out loud, because a rig that cannot report PTT should
                // not be offered a switch that mutes on it — see the
                // capabilities in radioProviders.js.
                pttAvailable: !this.unsupported.has('t'),
            });
            return true;
        } catch (err) {
            if (this.stopped) return false;
            // Once per spell of failure, not once per attempt.
            // A dead connection is not reused: the next cycle opens a new one,
            // which is also how a restarted rigctld is picked up.
            this.drop(err);
            if (!this.failing) {
                this.failing = true;
                this.onState({ connected: false, tx: false, error: `rigctld: ${err.message}` });
            }
            return false;
        }
    }

    setFrequency(hz) {
        return this.send(`F ${Math.round(Number(hz))}`);
    }

    setMode(sdrMode) {
        const mode = SDR_TO_RIGCTL[sdrMode];
        // A mode the pair does not share is not an error — see the table above.
        if (!mode) return Promise.resolve(false);
        // 0 for the passband: the rig's own default for that mode, rather than
        // this imposing the receiver's filter on it.
        return this.send(`M ${mode} 0`).then(() => true);
    }
}

module.exports = { RigctlLink, RIGCTL_TO_SDR, SDR_TO_RIGCTL, takeReply, DEFAULT_PORT };
