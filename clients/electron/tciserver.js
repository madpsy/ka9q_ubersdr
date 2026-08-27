'use strict';

// A TCI server: this receiver, offered to JTDX, WSJT-X, a logger, or anything
// else that speaks Expert Electronics' protocol.
//
// The mirror of tci.js. There, this client is a TCI *client* following a real
// radio; here it is the radio — it answers the handshake, reports the dial, and
// streams the receiver's audio, so software that only knows how to talk to a
// SunSDR can be pointed at a web SDR on the other side of the world.
//
// This is a control surface rather than a radio transport, and the page has a
// registry for exactly that (static/v2/src/controls/surfaces.js). SDR Control
// offers Off / FlexControl / MIDI, all of which a page can open by itself; a
// socket to listen on is not, so this registers itself and the panel renders
// what it asks for.
//
// ── The handshake ─────────────────────────────────────────────────────────
//
// A client connects and says nothing. The server describes itself, reports the
// state of every receiver, and finishes with `ready;` — the order below is the
// one clients/python/tci_server.py sends and which JTDX is known to accept:
//
//     device;  protocol;  receive_only;  trx_count;  channel_count;
//     vfo_limits;  if_limits;  modulations_list;
//     audio_samplerate;  iq_samplerate;
//     per receiver: rx_enable, dds, vfo×2, modulation, split_enable, trx;
//     ready;  start;
//
// Afterwards each side sends changes as they happen, in the same `name:args;`
// form. What arrives that this acts on is `vfo`/`dds` (retune), `modulation`
// (mode), and `audio_start`/`audio_stop`.
//
// ── Two receivers, one radio ───────────────────────────────────────────────
//
// `trx_count:2` is a lie of the useful sort, and the Python server tells it
// too: a UberSDR instance is one receiver, but clients written for a SunSDR
// expect a second and some will not start without one. RX1 is declared
// disabled and does nothing. Everything acted on is receiver 0.
//
// ── IQ ─────────────────────────────────────────────────────────────────────
//
// Not offered. `iq_start` would mean handing over the raw complex stream, which
// this client never receives — the page has demodulated audio and a spectrum,
// not baseband. `iq_samplerate` is answered because the handshake declares one.

const { createWsServer } = require('./wsserver.js');

// Not TCI's own 40001: that is where a radio listens, and this client may be a
// TCI client and a TCI server at once — following a rig on 40001 while offering
// this receiver to a logger. The surface's field carries the same default (see
// receiver-preload.js), and the operator can set whatever they like.
const DEFAULT_PORT = 60001;

// What TCI clients expect audio at. The receiver's own rate depends on the
// mode (12 kHz for SSB), so this resamples rather than declaring the true rate:
// WSJT-X and JTDX have 48 kHz assumptions well beyond the handshake, and the
// Python server before this one declared 48 k and resampled to it as well.
const AUDIO_RATE = 48000;

// Above this much unwritten audio the client is not keeping up. Roughly two
// thirds of a second at 48 kHz stereo float32 — long enough to ride out a
// scheduler hiccup, short enough that what does arrive is not minutes stale.
const BACKLOG_BYTES = 256 * 1024;

// Modulations, as TCI names them, in each direction.
//
// Deliberately not shared with tci.js: this is the other end of the
// conversation and the tables are not the same one. As a client, tci.js must
// never be *put into* digu or digl — there is no such receiver mode, and
// pretending otherwise would show a mode the operator cannot select. As a
// server it must accept both, because a client's data mode is how WSJT-X and
// JTDX ask for SSB, and refusing it means refusing the software this exists for.
const FROM_CLIENT = {
    usb: 'usb', lsb: 'lsb',
    digu: 'usb', digl: 'lsb',      // data modes are SSB with a convention attached
    cw: 'cwu',
    am: 'am', sam: 'sam',
    nfm: 'nfm', wfm: 'fm',
};
const TO_CLIENT = {
    usb: 'usb', lsb: 'lsb',
    cwu: 'cw', cwl: 'cw',
    am: 'am', sam: 'sam',
    nfm: 'nfm', fm: 'wfm',
};

// Declared to clients. Wider than what maps above, because the list is read as
// "what this radio is capable of" and a client that finds its usual mode
// missing may refuse to work at all; anything unmapped that arrives is simply
// not acted on.
const MODULATIONS = 'am,sam,dsb,lsb,usb,cw,nfm,wfm,digl,digu,spec,drm';

/**
 * Rate conversion, one block at a time.
 *
 * Linear interpolation, which for the 4× upsampling this actually does (12 kHz
 * to 48 kHz) is well-behaved: the images it leaves sit above 6 kHz, an octave
 * clear of anything a 3 kHz SSB channel contains, and every client this feeds
 * filters far below that. A windowed-sinc would be more correct and would cost
 * a dependency and a hundred lines to be inaudibly better.
 *
 * The state that matters is between blocks. Audio arrives in ~440-frame pieces
 * and the output rate does not divide them evenly, so the read position carries
 * over as a fraction and the last frame of each block is held to interpolate
 * against the first of the next. Dropping either — restarting at zero every
 * block — puts a discontinuity in at every boundary, which is a buzz at the
 * block rate rather than a rounding error.
 */
class Resampler {
    constructor(channels = 2) {
        this.channels = channels;
        this.prev = new Float32Array(channels);
        this.pos = 0;          // next output's position, in input frames
        this.primed = false;
    }

    reset() {
        this.prev = new Float32Array(this.channels);
        this.pos = 0;
        this.primed = false;
    }

    /**
     * `input` is interleaved, `frames` long. Returns interleaved output at
     * `outRate`, or `input` itself when the rates already agree.
     */
    process(input, frames, inRate, outRate) {
        if (!frames) return new Float32Array(0);
        if (inRate === outRate) {
            // Straight through, but the held frame still has to be right or a
            // later rate change starts from a stale sample.
            for (let c = 0; c < this.channels; c++) this.prev[c] = input[(frames - 1) * this.channels + c];
            this.primed = true;
            this.pos = 0;
            return input;
        }
        const step = inRate / outRate;
        const ch = this.channels;
        // The first block has no previous frame to interpolate from, so it
        // starts at the first real sample rather than half a step before it.
        if (!this.primed) { this.pos = 0; this.primed = true; }

        // Read positions run from -1 (the held frame) to frames-1 (the last one
        // in this block). Everything past that waits for the next block, which
        // is what makes the output length vary from block to block.
        const last = frames - 1;
        const count = this.pos > last ? 0 : Math.floor((last - this.pos) / step) + 1;
        const out = new Float32Array(count * ch);
        let pos = this.pos;
        for (let n = 0; n < count; n++, pos += step) {
            const i = Math.floor(pos);
            const frac = pos - i;
            for (let c = 0; c < ch; c++) {
                const a = i < 0 ? this.prev[c] : input[i * ch + c];
                const b = i + 1 <= last ? input[(i + 1) * ch + c] : a;
                out[n * ch + c] = a + (b - a) * frac;
            }
        }
        // Carry the read position into the next block's frame of reference, and
        // keep this block's last frame as that block's index -1.
        this.pos = pos - frames;
        for (let c = 0; c < ch; c++) this.prev[c] = input[last * ch + c];
        return out;
    }
}

/**
 * The 64-byte header in front of every audio frame.
 *
 * Sixteen little-endian uint32s, laid out as JTDX's `Data_Stream`
 * (TCITransceiver.hpp). `length` is the number of *floats*, not frames and not
 * stereo pairs — the field is easy to get wrong and a client reading half a
 * buffer hears the audio at double speed.
 */
function audioHeader(receiver, sampleRate, floats) {
    const header = Buffer.alloc(64);
    header.writeUInt32LE(receiver, 0);
    header.writeUInt32LE(sampleRate, 4);
    header.writeUInt32LE(3, 8);            // format: float32
    header.writeUInt32LE(0, 12);           // codec: none
    header.writeUInt32LE(0, 16);           // crc: unused
    header.writeUInt32LE(floats, 20);
    header.writeUInt32LE(1, 24);           // type: RxAudioStream
    return header;                         // 28..63 stay zero — reserved[9]
}

/** Splits a frame into its commands. Same wire format as tci.js. */
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

class TciServer {
    /**
     * `onControl` is how a client's command reaches the receiver: it is handed
     * `{ frequency }` or `{ mode }` in the page's own vocabulary, already
     * mapped out of TCI's. `onStatus` reports what to show in the panel.
     */
    constructor({ port, host, deviceName, onControl, onStatus } = {}) {
        this.port = Number(port) || DEFAULT_PORT;
        // Loopback by default. This hands out the receiver's audio and lets
        // whoever connects retune it, so it opens to the whole network only if
        // somebody says so.
        this.host = host || '127.0.0.1';
        this.deviceName = deviceName || 'UberSDR';
        this.onControl = onControl || (() => {});
        this.onStatus = onStatus || (() => {});

        this.server = null;
        this.clients = new Set();
        this.error = null;

        // How far the receiver tunes, in Hz, as advertised to clients in greet().
        //
        // This is the one place the desktop client tells a third-party app (Expert SDR,
        // SDC, logging software) what the dial may reach, and they bound their own dial
        // by it. It used to be a flat 0-60000000, which was wrong in both directions: on
        // a stock 64.8 Msps receiver it invited clients to dial 50 MHz and hear silence,
        // and the 0 low edge contradicted the 10 kHz every other client honours.
        //
        // The fallback is the same contract the rest of the tree uses: until the range is
        // known, 10 kHz - 30 MHz. setTuningRange() adopts the receiver's own.
        this.minFrequency = 10000;
        this.maxFrequency = 30000000;

        // The receiver's state, as clients have been told it.
        this.frequency = 14074000;
        this.mode = 'usb';               // TCI's name for it
        this.tx = false;
        this.streaming = new Set();      // receivers with audio_start outstanding
        this.resampler = new Resampler(2);
        this.dropped = 0;                // audio frames skipped for a slow client
    }

    // --- lifecycle ----------------------------------------------------------

    start() {
        if (this.server) return Promise.resolve(true);
        this.error = null;
        return new Promise((resolve) => {
            const server = createWsServer({ onConnection: (conn) => this.accept(conn) });
            server.once('error', (err) => {
                // The common one by far is EADDRINUSE — another TCI server, or
                // a second copy of this app. Said plainly, because "listen
                // EADDRINUSE 127.0.0.1:60001" is not what the operator needs to
                // read in a panel.
                this.error = err.code === 'EADDRINUSE'
                    ? `port ${this.port} is already in use`
                    : err.message;
                this.server = null;
                try { server.close(); } catch (e) { /* never listened */ }
                this.report();
                resolve(false);
            });
            server.listen(this.port, this.host, () => {
                this.server = server;
                this.report();
                resolve(true);
            });
        });
    }

    stop() {
        const server = this.server;
        this.server = null;
        for (const conn of Array.from(this.clients)) conn.close(1001, 'server stopping');
        this.clients.clear();
        this.streaming.clear();
        this.resampler.reset();
        if (server) {
            server.removeAllListeners('error');
            try {
                server.close();
                // An upgraded socket stays on the http server's books for ever,
                // so `close` alone leaves the port held by connections that
                // have been told to go. Without this, switching the surface off
                // and on again fails with "already in use".
                server.closeAllConnections?.();
            } catch (e) { /* not listening */ }
        }
        this.report();
    }

    status() {
        return {
            running: !!this.server,
            clients: this.clients.size,
            error: this.error,
            detail: this.server ? `listening on ${this.host}:${this.port}` : null,
            // Whether anyone has actually asked for audio. Said out loud so the
            // tap on the page's audio can be opened only while it is wanted —
            // a server nobody is streaming from should cost the receiver
            // nothing per block.
            streaming: this.streaming.size > 0,
        };
    }

    report() {
        try { this.onStatus(this.status()); } catch (e) { /* not ours to fix */ }
    }

    // --- clients ------------------------------------------------------------

    accept(conn) {
        this.clients.add(conn);
        conn.onmessage = (data, isText) => {
            // Binary from a client is transmit audio, and this receiver has no
            // transmitter. Discarded rather than refused: a client that streams
            // it unasked is not misbehaving, it is being a client.
            if (isText) this.onText(conn, data);
        };
        conn.onclose = () => {
            this.clients.delete(conn);
            // Audio is per-server rather than per-client, so the last one out
            // turns it off. Otherwise a client that connects, streams and
            // vanishes leaves the tap open for ever.
            if (!this.clients.size) {
                this.streaming.clear();
                this.resampler.reset();
            }
            this.report();
        };
        this.greet(conn);
        this.report();
    }

    /**
     * Adopt the receiver's tuning range, from /api/description's `tuning_range`.
     *
     * Each edge falls back on its own, `> 0` so a 0 or a null cannot become a limit, and
     * an inverted range is refused wholesale rather than advertised backwards. Returns
     * whether anything moved.
     *
     * Only affects clients that connect afterwards: TCI has no message for revising
     * vfo_limits mid-session, so an already-connected client keeps what it was greeted
     * with. That is why main.js sets this before the server is started.
     */
    setTuningRange(range) {
        const r = range || {};
        const pick = (v, was) =>
            (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : was);
        const min = pick(r.min_frequency, this.minFrequency);
        const max = pick(r.max_frequency, this.maxFrequency);
        if (max <= min) return false;
        const changed = min !== this.minFrequency || max !== this.maxFrequency;
        this.minFrequency = min;
        this.maxFrequency = max;
        return changed;
    }

    greet(conn) {
        const lines = [
            `device:${this.deviceName};`,
            'protocol:ubersdr,1.0;',
            // No transmitter, and clients that respect this stop offering to
            // key one.
            'receive_only:true;',
            'trx_count:2;',
            'channel_count:2;',
            `vfo_limits:${this.minFrequency},${this.maxFrequency};`,
            // The IF passband a client may place itself within, either side of
            // the tuned frequency.
            'if_limits:-48000,48000;',
            `modulations_list:${MODULATIONS};`,
            `audio_samplerate:${AUDIO_RATE};`,
            `iq_samplerate:${AUDIO_RATE};`,
        ];
        for (const rx of [0, 1]) {
            lines.push(`rx_enable:${rx},${rx === 0 ? 'true' : 'false'};`);
            lines.push(`dds:${rx},${this.frequency};`);
            lines.push(`vfo:${rx},0,${this.frequency};`);
            lines.push(`vfo:${rx},1,${this.frequency};`);
            lines.push(`modulation:${rx},${this.mode};`);
            lines.push('split_enable:' + rx + ',false;');
            lines.push(`trx:${rx},false;`);
        }
        lines.push('ready;');
        // The power state. `start` here is the server saying it is switched on,
        // which is not the same command a client sends to switch it on.
        lines.push('start;');
        for (const line of lines) conn.text(line);
    }

    broadcast(text) {
        for (const conn of Array.from(this.clients)) conn.text(text);
    }

    // --- commands from clients ----------------------------------------------

    onText(conn, message) {
        for (const { name, args } of parseFrame(message)) {
            try {
                this.handle(conn, name, args);
            } catch (e) { /* a malformed command is not worth a dropped client */ }
        }
    }

    handle(conn, name, args) {
        const rx = args.length ? parseInt(args[0], 10) : 0;
        switch (name) {
            case 'vfo':
                // vfo:<rx>,<vfo>,<hz> to set; vfo:<rx>,<vfo> to ask.
                if (args.length >= 3) this.tuneFromClient(rx, parseInt(args[1], 10), parseInt(args[2], 10));
                else if (args.length >= 2) conn.text(`vfo:${rx},${args[1]},${this.frequency};`);
                break;
            case 'dds':
                // The panorama's centre. This receiver has no separate centre —
                // it is tuned where it is listening — so the two move together,
                // which is also how the Python server behaves.
                if (args.length >= 2) this.tuneFromClient(rx, 0, parseInt(args[1], 10));
                else conn.text(`dds:${rx},${this.frequency};`);
                break;
            case 'modulation':
                if (args.length >= 2) this.modeFromClient(rx, String(args[1]).toLowerCase());
                else conn.text(`modulation:${rx},${this.mode};`);
                break;
            case 'audio_start':
                this.streaming.add(rx);
                this.resampler.reset();
                this.broadcast(`audio_start:${rx};`);
                this.report();
                break;
            case 'audio_stop':
                this.streaming.delete(rx);
                this.broadcast(`audio_stop:${rx};`);
                this.report();
                break;
            case 'trx':
                // A receiver cannot transmit. Answered rather than ignored, so
                // a client that keys up is told immediately that it did not.
                this.broadcast(`trx:${rx},false;`);
                break;
            case 'rx_smeter':
                // args: rx, channel. Reported in dBm; the signal level is not
                // plumbed through to here, so this is the floor rather than a
                // number invented to look plausible.
                conn.text(`rx_smeter:${rx},${args[1] || 0},-127;`);
                break;
            case 'device':
                conn.text(`device:${this.deviceName};`);
                break;
            case 'protocol':
                conn.text('protocol:ubersdr,1.0;');
                break;
            case 'rx_enable':
                conn.text(`rx_enable:${rx},${rx === 0 ? 'true' : 'false'};`);
                break;
            case 'split_enable':
                conn.text(`split_enable:${rx},false;`);
                break;
            case 'start':
            case 'stop':
                // Power. There is nothing to switch off, and answering keeps a
                // client that waits for the echo from hanging.
                this.broadcast(`${name};`);
                break;
            case 'iq_start':
            case 'iq_stop':
            case 'iq_samplerate':
                // Acknowledged, not implemented — see the note at the top.
                if (name === 'iq_samplerate') this.broadcast(`iq_samplerate:${AUDIO_RATE};`);
                break;
            default:
                break;
        }
    }

    tuneFromClient(rx, vfo, hz) {
        if (rx !== 0 || !Number.isFinite(hz)) return;
        // VFO B is the transmit VFO under split. Followed in the state so a
        // client reading it back gets what it wrote, but it never retunes
        // anything.
        if (vfo !== 0) { this.broadcast(`vfo:${rx},${vfo},${hz};`); return; }
        if (hz === this.frequency) return;
        this.frequency = hz;
        // Echoed to everyone including the sender, which is how TCI confirms.
        this.broadcast(`dds:0,${hz};`);
        this.broadcast(`vfo:0,0,${hz};`);
        this.onControl({ frequency: hz });
    }

    modeFromClient(rx, mode) {
        if (rx !== 0 || mode === this.mode) return;
        const sdrMode = FROM_CLIENT[mode];
        // Kept even when it maps to nothing, so a client that sets `drm` and
        // reads it back is not told it failed — but nothing is retuned.
        this.mode = mode;
        this.broadcast(`modulation:0,${mode};`);
        if (sdrMode) this.onControl({ mode: sdrMode });
    }

    // --- the receiver, changing under us ------------------------------------

    /**
     * The receiver was tuned, or its mode changed, or the rig it is following
     * keyed up. Only differences go out — a client is entitled to assume a
     * message means something moved.
     */
    update({ frequency, mode, tx } = {}) {
        if (Number.isFinite(frequency) && frequency !== this.frequency) {
            this.frequency = frequency;
            this.broadcast(`dds:0,${frequency};`);
            this.broadcast(`vfo:0,0,${frequency};`);
        }
        if (mode) {
            const tciMode = TO_CLIENT[String(mode).toLowerCase()];
            // A receiver mode with no TCI name (the digital modes, spectrum)
            // leaves the client on the last one it was told, which is closer to
            // the truth than any substitute would be.
            if (tciMode && tciMode !== this.mode) {
                this.mode = tciMode;
                this.broadcast(`modulation:0,${tciMode};`);
            }
        }
        if (tx !== undefined && !!tx !== this.tx) {
            this.tx = !!tx;
            this.broadcast(`trx:0,${this.tx};`);
        }
    }

    /**
     * Audio from the receiver: interleaved stereo float32 at whatever rate the
     * mode runs at.
     *
     * Resampled to 48 kHz, wrapped in its header and sent as one binary frame
     * per block. A client too slow to drain what it has already been sent is
     * skipped rather than queued behind: audio being fed to a decoder is worth
     * nothing late, and a growing kernel buffer is how a stalled client takes
     * the whole process's memory with it.
     */
    pushAudio(pcm, frames, sampleRate) {
        if (!this.server || !this.clients.size || !this.streaming.has(0)) return false;
        if (!frames || !Number.isFinite(sampleRate) || sampleRate <= 0) return false;

        const resampled = this.resampler.process(pcm, frames, sampleRate, AUDIO_RATE);
        if (!resampled.length) return false;

        // A view of the right bytes, not a copy of them: `process` may return
        // a subarray of a larger buffer.
        const body = Buffer.from(resampled.buffer, resampled.byteOffset, resampled.byteLength);
        const frame = Buffer.concat([audioHeader(0, AUDIO_RATE, resampled.length), body]);

        let sent = false;
        for (const conn of Array.from(this.clients)) {
            if (conn.socket.writableLength > BACKLOG_BYTES) { this.dropped++; continue; }
            conn.binary(frame);
            sent = true;
        }
        return sent;
    }
}

module.exports = {
    TciServer, Resampler, audioHeader, parseFrame,
    FROM_CLIENT, TO_CLIENT, AUDIO_RATE, DEFAULT_PORT,
};
