// Audio WebSocket client (/ws).
//
// Wire format, requested as `format=opus&version=3`:
//
//   binary frame: [timestamp u64][sampleRate u32][channels u8]
//                 [basebandPower f32][noisePower f32][opus payload...]
//   text frame:   JSON control messages (status / error / pong / agc_state ...)
//
// The other format the server offers is `pcm-zstd`, lossless 16-bit PCM at
// four to eight times the bandwidth depending on the mode's sample rate, which
// the operator can ask for from the Audio panel. Its frames are shaped
// differently and are decoded in pcm-stream.js. The format is fixed in the
// connect URL — there is no command for it — so changing it means reopening
// the socket.
//
// The server falls back to JSON `audio` messages (base64 PCM) when Opus is
// unavailable; that path is handled too so the UI still works on such a server.

import { Emitter } from './emitter.js';
import { failureKind } from '../lib/connectFailure.js';
import { PCMStreamDecoder, isZstdFrame } from './pcm-stream.js';
import {
    HANDSHAKE_TIMEOUT_MS, abandon, checkSocket, reviveOnWake,
} from './socket-health.js';
import {
    connectionCheck, frameSize, getBypassPassword, getSessionId, setServerSessionId, wsBase,
} from './session.js';

// Protocol version asked for at connect.
//
// Version 3 differs from 2 only in the second signal-quality field: it carries
// the noise power inside the demodulator passband rather than radiod's density
// N0 in dBFS/Hz. That is what makes `basebandPower - noisePower` an SNR in dB —
// on version 2 the same subtraction yields S/N0 in dB·Hz, reading about 34 dB
// high on a 2.65 kHz filter and shifting whenever the filter width changed.
// The byte layout is identical, so only the meaning of the field moves.
const PROTOCOL_VERSION = 3;

// Version 2/3 header: timestamp(8) sampleRate(4) channels(1) power(4) noise(4).
const HEADER_BYTES = 21;

export class AudioConnection extends Emitter {
    constructor() {
        super();
        this.ws = null;
        this.state = 'idle';        // idle | connecting | open | reconnecting | rejected
        this.params = null;         // last successful connect params, for reconnect
        // 'opus' | 'pcm-zstd'. Kept off `params` because it is not part of the
        // tuning, and on the instance so a reconnect keeps it without the
        // caller having to remember.
        this.format = 'opus';
        this.pcm = new PCMStreamDecoder();
        this.closedByUser = false;
        // Whether the socket in hand ever reached open. This endpoint says most
        // of what it has to say *after* the upgrade — see _onMessage — but the
        // ban middleware and a malformed id are answered before it, and a
        // browser reports a refused upgrade as a bare 1006 with no status and no
        // reason, indistinguishable from the network dropping. See _onClose.
        this.opened = false;
        // A connect that has not reached `new WebSocket` yet, because it is
        // still waiting on /connection. Without it a second connect() during
        // that await opens a second socket and orphans the first — see the
        // guard in connect(), and socket-health.js for what an orphan costs.
        this.opening = false;
        // Set when there is reason to think the server has forgotten this id,
        // and consumed by the next connect() as one re-registration. Not a
        // standing flag: it is cleared as it is spent, so a retry that fails the
        // same way asks again and a retry that succeeds never asks at all.
        this.needsRegistration = false;
        this.attempts = 0;
        this.maxAttempts = 12;
        this.reconnectTimer = null;
        // When the socket in hand was created, and when it last heard anything.
        // Both are read by socket-health.js: the first bounds the handshake, the
        // second is what a probe watches for an answer.
        this.openedAt = 0;
        this.lastRxAt = 0;
        this.handshakeTimer = null;
        this._probeTimer = null;
        reviveOnWake(this);
        // Bytes taken off this socket, ever. Cumulative and never reset, so a
        // reader only has to take deltas — see the Receiver info panel, which
        // is the only thing that looks at it.
        this.bytesIn = 0;
        // How the server last refused us, held only from the error message to
        // the close that follows it — see _onMessage and _onClose.
        this.lastFailure = null;
    }

    get connected() {
        return this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    // Takes effect on the next connect: the server reads the format from the
    // URL and never changes it for the life of a socket.
    setFormat(format) {
        this.format = format === 'pcm-zstd' ? 'pcm-zstd' : 'opus';
        return this.format;
    }

    async connect(params) {
        this.closedByUser = false;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        // One socket per connection, always. `ws` is not assigned until after
        // the await below, so without this a second caller during the check
        // opens a second socket and the first is orphaned — silenced by
        // superseded(), never closed, and left in CONNECTING for ever if the
        // handshake had not landed yet. Two clicks on the power button, or the
        // idle watch resuming while a wake is already in flight, was enough.
        //
        // Before `params` is recorded, deliberately: the socket that is already
        // up is tuned to the old ones, and they are what a reconnect has to come
        // back to. The reconnect timer above is still cleared first — a caller
        // asking for a connection now should not be left waiting out a backoff.
        if (this.ws || this.opening) return true;
        this.opening = true;
        this.params = { ...params };
        // Whatever the last session announced does not describe this one.
        this.pcm.reset();

        // Spent here, whatever the check then answers: a re-registration that
        // was refused is not one to make again on the next attempt, and the
        // refusal itself is what settles whether there is a next attempt.
        const reregister = this.needsRegistration;
        this.needsRegistration = false;
        if (reregister) {
            this.emit('reregister', { message: 'Registering this session with the receiver again' });
        }
        const check = await connectionCheck({ reregister });
        // Cleared the moment the await is over and before anything can return,
        // so every path out of here leaves the flag matching reality: from here
        // down either a socket is assigned or there is none.
        this.opening = false;
        // Somebody let go while the check was in flight — powerOff, or the idle
        // watch stopping the receiver. Without this the socket opens anyway:
        // disconnect() has already closed a socket that did not exist yet and
        // set closedByUser on a connection that is about to clear it, so a
        // receiver that was stopped comes up streaming. The DX cluster socket
        // has always had this check.
        if (this.closedByUser) return false;
        if (!check.allowed) {
            // Three answers, not two — see lib/connectFailure.js. The /maximum/
            // test that used to live here read "rate limit exceeded" and "your
            // session has been terminated" as the same thing as a ban, so the
            // socket gave up permanently on a refusal that clears itself in
            // seconds, and the page had to be reloaded to get any audio at all.
            const fail = failureKind(check.reason, check.status);
            this._setState('rejected');
            this.emit('error', {
                kind: 'rejected', failure: fail, message: check.reason, status: check.status,
            });
            if (fail === 'retry') this._scheduleReconnect();
            return false;
        }

        const q = new URLSearchParams({
            frequency: String(Math.round(params.frequency)),
            mode: params.mode,
            bandwidthLow: String(Math.round(params.bandwidthLow)),
            bandwidthHigh: String(Math.round(params.bandwidthHigh)),
            user_session_id: getSessionId(),
            format: this.format,
            version: String(PROTOCOL_VERSION),
        });
        const password = getBypassPassword();
        if (password) q.set('password', password);

        this._setState('connecting');
        let ws;
        try {
            ws = new WebSocket(`${wsBase()}/ws?${q}`);
        } catch (err) {
            this.emit('error', { kind: 'open-failed', message: String(err) });
            this._scheduleReconnect();
            return false;
        }
        ws.binaryType = 'arraybuffer';
        this.ws = ws;
        this.opened = false;
        this.openedAt = Date.now();
        this.lastRxAt = this.openedAt;
        // Nothing else in this client can see an upgrade that is never answered.
        // The whole reconnect machinery hangs off onclose, and a socket that
        // never opens never closes, so without a deadline the connection waits
        // for an event that is not coming — which is what leaves the row in
        // devtools Pending with no status and the page waiting on audio for
        // ever. See socket-health.js.
        clearTimeout(this.handshakeTimer);
        this.handshakeTimer = setTimeout(() => {
            this.handshakeTimer = null;
            if (this.ws !== ws || this.opened) return;
            this._revive('handshake');
        }, HANDSHAKE_TIMEOUT_MS);

        // Events from a socket that has since been replaced. Closing is not
        // instant — the handshake outlives the call — so a close-then-connect
        // (changing the audio format, or powering off and straight back on)
        // can land the old socket's close event after the new one is live,
        // where `this.ws = null` in _onClose would leave a connected stream
        // that send() refuses to write to. A plain disconnect leaves this.ws
        // null and still goes through, so nothing else changes.
        const superseded = () => this.ws && this.ws !== ws;

        ws.onopen = () => {
            if (superseded()) return;
            this.opened = true;
            clearTimeout(this.handshakeTimer);
            this.handshakeTimer = null;
            // The reconnect budget is deliberately *not* refilled here. The
            // server upgrades the socket before it decides whether it will have
            // us — the session is created afterwards — so a refusal arrives as
            // open-then-error-then-close, and clearing the count on the open
            // event reset the backoff on exactly the failure it exists for. A
            // rate-limited client then retried once a second for as long as the
            // page was up. _onMessage refills it instead, on the first packet:
            // audio arriving is proof rather than promise.
            this._setState('open');
            this.emit('open');
            // The server sends no unsolicited status for binary audio formats,
            // so ask for one — the UI should reflect what the server actually
            // tuned, not only what we requested.
            this.send({ type: 'get_status' });
            // No keepalive timer. Every message touches the session server
            // side, ping included, so a timer here would make the session
            // immortal and the operator's slot unreclaimable. The idle watch
            // pings on activity instead — see radio/idle.js.
        };
        ws.onmessage = (ev) => { if (!superseded()) this._onMessage(ev); };
        ws.onerror = () => {
            if (superseded()) return;
            this.emit('error', { kind: 'socket', message: 'audio socket error' });
        };
        ws.onclose = (ev) => { if (!superseded()) this._onClose(ev); };
        return true;
    }

    disconnect() {
        this.closedByUser = true;
        this.opening = false;
        this._disarm();
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        if (this.ws) {
            try { this.ws.close(1000, 'client'); } catch (e) { /* ignore */ }
        }
        this.ws = null;
        this._setState('idle');
    }

    // Is the socket still there? Asked by socket-health.js when the page comes
    // back from being hidden, asleep or offline, and never on a timer.
    checkAlive(timers) {
        return checkSocket(this, timers);
    }

    // Keepalive, sent when the operator does something rather than on a timer —
    // see radio/idle.js for why that distinction is the whole point.
    ping() {
        return this.send({ type: 'ping' });
    }

    send(msg) {
        if (!this.connected) return false;
        this.ws.send(JSON.stringify(msg));
        return true;
    }

    // ---- commands -------------------------------------------------------

    tune({ frequency, mode, bandwidthLow, bandwidthHigh }) {
        const msg = { type: 'tune' };
        if (frequency != null) msg.frequency = Math.round(frequency);
        if (mode != null) msg.mode = mode;
        if (bandwidthLow != null) msg.bandwidthLow = Math.round(bandwidthLow);
        if (bandwidthHigh != null) msg.bandwidthHigh = Math.round(bandwidthHigh);
        if (this.params) Object.assign(this.params, { frequency, mode, bandwidthLow, bandwidthHigh });
        return this.send(msg);
    }

    // Squelch. Uses the server-side audio gate rather than radiod's set_squelch,
    // matching v1 — see the note in constants.js. Pass SQUELCH_SENTINEL to
    // disable a threshold; omitted fields are left unchanged by the server.
    setAudioGate({ minSnr, minPower } = {}) {
        const msg = { type: 'set_audio_gate' };
        if (minSnr != null) msg.min_snr = minSnr;
        if (minPower != null) msg.min_power = minPower;
        if (msg.min_snr == null && msg.min_power == null) return false;
        // Remembered so a reconnect can restore the gate — a fresh session
        // starts with both thresholds disabled.
        this.lastGate = { minSnr, minPower };
        return this.send(msg);
    }

    setAGC(params) {
        return this.send({ type: 'set_agc', ...params });
    }

    requestAGC() {
        return this.send({ type: 'get_agc' });
    }

    setDSP(filter, enabled, params) {
        return this.send({ type: 'set_dsp', filter, enabled, params: params || {} });
    }

    // Adjusts parameters of the running filter without restarting it. Only
    // valid while a DSP insert is active.
    setDSPParams(params) {
        if (!params || Object.keys(params).length === 0) return false;
        return this.send({ type: 'set_dsp_params', params });
    }

    // Asks for the filter list and each filter's parameter schema.
    requestDSPFilters() {
        return this.send({ type: 'get_dsp_filters' });
    }

    setMuted(muted) {
        return this.send({ type: 'set_mute', muted });
    }

    // ---- internals ------------------------------------------------------

    _setState(state) {
        if (this.state === state) return;
        this.state = state;
        this.emit('state', state);
    }

    // Timers that belong to the socket in hand rather than to the connection.
    _disarm() {
        clearTimeout(this.handshakeTimer);
        clearTimeout(this._probeTimer);
        this.handshakeTimer = null;
        this._probeTimer = null;
    }

    // Let go of a socket that is not going to say anything for itself: a
    // handshake nothing answered, or one that was open when the machine went to
    // sleep and is half-open now. Neither will ever fire an event, so the close
    // is reported here — _onClose cannot run, because abandon() detaches the
    // handlers first, and it must: a browser that does eventually notice the
    // dead connection would otherwise land a close on whatever socket has
    // replaced this one by then.
    _revive(reason) {
        const ws = this.ws;
        if (!ws) return;
        this._disarm();
        abandon(ws);
        this.ws = null;
        this.opened = false;
        setServerSessionId(null);
        this.emit('close', { code: 1006, reason, failure: null });
        if (this.closedByUser) {
            this._setState('idle');
            return;
        }
        this._scheduleReconnect();
    }

    _onMessage(ev) {
        // Any frame at all, including the pong below: what this timestamp is
        // for is answering "did the server say anything", not "was it useful".
        this.lastRxAt = Date.now();
        this.bytesIn += frameSize(ev.data);
        if (ev.data instanceof ArrayBuffer) {
            this._onBinary(ev.data);
            this.attempts = 0;
            return;
        }
        let msg;
        try {
            msg = JSON.parse(ev.data);
        } catch (err) {
            return;
        }
        if (msg.type === 'error') {
            // The server upgrades the socket and only then decides whether it
            // will have us — a session it has already reclaimed, a creation
            // rate limit — so a refusal arrives here rather than as a failed
            // handshake, and is followed by a close. Remembered so _onClose
            // knows whether that close is worth retrying: by itself it looks
            // like any other, and the clean code the server sends with it used
            // to mean "the operator asked for this" and stop everything.
            this.lastFailure = failureKind(msg.error, msg.status);
            this.emit('error', {
                kind: 'server', failure: this.lastFailure, message: msg.error, status: msg.status,
            });
            return;
        }
        if (msg.type === 'pong') return;
        // The server's own id for this session. Nothing here needs it, but
        // /stats does — see setServerSessionId.
        if (msg.type === 'status' && msg.sessionId) setServerSessionId(msg.sessionId);
        if (msg.type === 'audio' && msg.data) {
            // JSON PCM fallback: base64 signed 16-bit little-endian.
            const raw = atob(msg.data);
            const bytes = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
            const pcm = new Int16Array(bytes.buffer);
            const channels = msg.channels || 1;
            const frames = Math.floor(pcm.length / channels);
            const planes = [];
            for (let c = 0; c < channels; c++) {
                const plane = new Float32Array(frames);
                for (let i = 0; i < frames; i++) plane[i] = pcm[i * channels + c] / 32768;
                planes.push(plane);
            }
            // Same proof as a binary frame, on the JSON fallback path — a
            // server with no Opus encoder must not be left on a backoff that
            // only the binary path can clear.
            this.attempts = 0;
            this.emit('pcm', { planes, sampleRate: msg.sampleRate || 12000, channels });
            return;
        }
        this.emit('message', msg);
    }

    _onBinary(buffer) {
        // Two shapes arrive here. What was asked for settles it in the normal
        // case; the sniff catches the server that answered `format=opus` with
        // pcm-zstd because it has no Opus encoder.
        if (this.format === 'pcm-zstd' || isZstdFrame(buffer)) {
            this._onPCMBinary(buffer);
            return;
        }

        // The header layout is fixed by the version we request at connect time,
        // so it can be parsed unconditionally.
        if (buffer.byteLength <= HEADER_BYTES) return;
        const view = new DataView(buffer);
        const sampleRate = view.getUint32(8, true);
        const channels = view.getUint8(12) || 1;

        let basebandPower = view.getFloat32(13, true);
        let noisePower = view.getFloat32(17, true);
        // -999 is the server's "no channel status available" sentinel. On
        // version 3 the noise field is also -999 when radiod has reported no
        // usable filter edges, since N0 without a bandwidth cannot be scaled.
        if (!(basebandPower > -998)) basebandPower = null;
        if (!(noisePower > -998)) noisePower = null;
        this.emit('quality', { basebandPower, noisePower });

        this.emit('opus', {
            data: new Uint8Array(buffer, HEADER_BYTES),
            sampleRate,
            channels,
        });
    }

    // Lossless frames, decoded into the same planar floats the JSON fallback
    // produces so the player has one PCM entry point rather than two.
    _onPCMBinary(buffer) {
        const frame = this.pcm.decode(buffer);
        if (!frame) return;
        // Only a full header carries it, and every packet in the modes v2
        // offers has one — but a minimal header must leave the meters showing
        // the last reading rather than blanking them.
        if (frame.signal) this.emit('quality', frame.signal);
        this.emit('pcm', {
            planes: frame.planes,
            sampleRate: frame.sampleRate,
            channels: frame.channels,
        });
    }

    _onClose(ev) {
        this.ws = null;
        this._disarm();
        // The session it belonged to is gone; a reconnect is given a new one.
        setServerSessionId(null);
        const failure = this.lastFailure;
        this.lastFailure = null;
        const opened = this.opened;
        this.opened = false;
        this.emit('close', { code: ev.code, reason: ev.reason, failure });
        if (this.closedByUser) {
            this._setState('idle');
            return;
        }
        // A refusal the server explained a moment ago settles it, whatever code
        // it closed with. This is the case that reads as "the audio just stopped
        // and never came back": the server sends its error and then closes
        // cleanly, and a clean code was taken as the operator having asked to
        // stop — so a rate limit that clears in ten seconds ended the session
        // for good.
        if (failure) {
            // The server does not know this id — because it has forgotten it,
            // not because it has finished with it. One POST under the same id
            // fixes that, and the next attempt makes it. Until this existed the
            // two were one answer, so a receiver that restarted underneath a
            // listener left them looking at a dead page with a notice telling
            // them to press Listen.
            if (failure === 'reregister') this.needsRegistration = true;
            if (failure === 'retry' || failure === 'reregister') this._scheduleReconnect();
            else this._setState('idle');
            return;
        }
        // 1000 and 1001 with nothing said: a deliberate close from the other
        // end, or the page going away. Neither is ours to argue with.
        if (ev.code === 1000 || ev.code === 1001) {
            this._setState('idle');
            return;
        }
        // Nothing was ever open, and nothing was said. A refused upgrade looks
        // exactly like a pulled cable from in here — 1006, no status, no reason
        // — and one of the two is ours to mend, so the next attempt asks
        // /connection which it was. One POST per outage: the flag is spent by
        // that attempt and only set again by another close that never opened.
        if (!opened) this.needsRegistration = true;
        this._scheduleReconnect();
    }

    _scheduleReconnect() {
        if (this.reconnectTimer || !this.params || this.closedByUser) return;
        if (this.attempts >= this.maxAttempts) {
            this._setState('idle');
            // 'identity', not a plea to reload. Twelve failures over two
            // minutes is a session the server is not going to give back, and
            // the answer to that is a new one — which is what the receiver
            // stopping and being started again produces. Telling the operator
            // to reload was the client admitting it had no way back; it has one.
            this.emit('error', {
                kind: 'give-up',
                failure: 'identity',
                message: 'Lost the audio connection and could not get it back.',
            });
            return;
        }
        const delay = Math.min(30000, 1000 * Math.pow(1.6, this.attempts));
        this.attempts++;
        this._setState('reconnecting');
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect(this.params);
        }, delay);
    }
}
