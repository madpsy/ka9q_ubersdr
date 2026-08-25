// Spectrum WebSocket client (/ws/user-spectrum).
//
// Two kinds of binary frame arrive on this socket:
//
//   1. Spectrum data, magic "SPEC" (0x53 0x50 0x45 0x43):
//        header 22 bytes: magic(4) version(1) flags(1) timestamp u64 freq u64
//        flags 0x01 full float32   0x02 delta float32
//              0x03 full uint8     0x04 delta uint8   (binary8 mode)
//        delta payload: changeCount u16, then [index u16, value] pairs
//   2. Everything else: gzip-compressed JSON control messages.
//
// binary8 mode is requested because it cuts spectrum bandwidth by ~75% and the
// 1 dB quantisation is well below what a waterfall can show.
//
// Bin ordering: radiod emits raw FFT order, [DC..+Nyquist, -Nyquist..DC], so
// the two halves have to be swapped to get low-to-high frequency. Delta frames
// index the *raw* order, so the accumulators are kept raw and the swap happens
// on the way out, into a separate buffer.

import { Emitter } from './emitter.js';
import { connectionCheck, frameSize, getBypassPassword, getSessionId, wsBase } from './session.js';
import { clampCenter } from '../lib/zoom.js';
import { failureKind } from '../lib/connectFailure.js';
import {
    HANDSHAKE_TIMEOUT_MS, abandon, checkSocket, reviveOnWake,
} from './socket-health.js';

const HEADER_BYTES = 22;

// Narrowest span (Hz) the normal zoom controls will reach. It is a *span*, not
// a Hz/bin value, so zoom depth does not change with spectrum.bin_count.
//
// Two rungs below where this used to sit, and below where v1's own copy still
// does (static/spectrum-display.js) — so the two frontends no longer stop
// together. Nothing technical was stopping either of them: the server snaps to
// BIN_BW_LADDER down to 0.5 Hz/bin, which on a 1024-bin receiver is a 512 Hz
// span, and 10240 was only ever a UI choice the two shared.
//
// What sets the real limit is integration time rather than radiod, because
// resolution bandwidth is roughly the reciprocal of how long you look:
//
//	10 Hz/bin  10240 Hz span  0.1 s per line
//	 5 Hz/bin   5120 Hz span  0.2 s
//	 2 Hz/bin   2048 Hz span  0.5 s   <- here
//	 1 Hz/bin   1024 Hz span  1.0 s
//	0.5 Hz/bin   512 Hz span  2.0 s
//
// 2 Hz/bin is the last rung that still feels live. Below it each waterfall line
// covers a second or more of signal, so keying and fading smear into it and the
// display reads as laggy rather than detailed.
//
// Exported because a control that draws the zoom ladder rather than stepping
// along it — the Multipad's zoom barrel — has to know where the ladder ends.
export const MIN_ZOOM_SPAN_HZ = 2048;

export class SpectrumConnection extends Emitter {
    constructor() {
        super();
        // How the server last refused us, held only from the error message to
        // the close that follows it — see _onMessage and _onClose.
        this.lastFailure = null;
        this.ws = null;
        this.state = 'idle';
        this.closedByUser = false;
        // Whether the socket in hand ever reached open. The refusals this
        // endpoint gives before the upgrade — an unregistered id, a kicked one,
        // an IP that does not match — are plain HTTP errors, and a browser
        // reports all of them as a bare 1006 with no status and no reason. So
        // "it never opened" is the only evidence there is that the server said
        // something rather than the network dropping it. See _onClose.
        this.opened = false;
        // A connect that has not reached `new WebSocket` yet, because it is
        // still waiting on /connection — see the guard in connect(). The
        // spectrum has more ways into that race than the audio socket does:
        // resumeSpectrum() has four callers, and the idle pause and the hidden
        // tab can reach for it at the same moment.
        this.opening = false;
        // Set when there is reason to think the server has forgotten this id,
        // and consumed by the next connect() as one re-registration. Not a
        // standing flag: it is cleared as it is spent, so a retry that fails the
        // same way asks again and a retry that succeeds never asks at all.
        this.needsRegistration = false;
        this.attempts = 0;
        this.maxAttempts = 12;
        this.reconnectTimer = null;
        // Read by socket-health.js — the handshake deadline and the probe.
        this.openedAt = 0;
        this.lastRxAt = 0;
        this.handshakeTimer = null;
        this._probeTimer = null;
        reviveOnWake(this);
        // Bytes taken off this socket, ever — see AudioConnection.bytesIn.
        this.bytesIn = 0;
        // Frames decoded off it, ever. Same shape as bytesIn and for the same
        // reason: a counter costs nothing on the packet path, and anything that
        // wants a rate differences it on a timer of its own. This is what the
        // spectrum's stats readout shows as the feed rate — the number that makes
        // a halved poll divisor, a struggling server or a stalled socket visible
        // as something other than "the waterfall looks slow".
        this.framesIn = 0;

        // Server-reported view geometry, from the `config` message.
        this.centerFreq = 0;
        this.binCount = 0;
        this.binBandwidth = 0;
        this.defaultBinCount = 0;
        this.defaultBinBandwidth = 0;
        this.initialBinBandwidth = 0;   // first value seen, i.e. the full-span view

        // The poll divisor last asked for — see setRate. Tracked rather than
        // read back, because the server echoes no such field: the status reply
        // carries the view geometry and nothing about the rate.
        this.rateDivisor = 1;

        // Delta-decode accumulators, in raw radiod bin order.
        this._float = null;   // Float32Array
        this._u8 = null;      // Uint8Array
        // Reusable output buffer holding the frequency-ordered bins.
        this._out = null;
    }

    get connected() {
        return this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    get span() {
        return this.binCount * this.binBandwidth;
    }

    // Hz/bin at the narrowest view the zoom controls will produce. Uses the
    // *default* bin count deliberately: the server's deep-zoom path reduces
    // session.BinCount, and the floor must not move when it does.
    minBinBandwidthForUI() {
        const bins = this.defaultBinCount || this.binCount || 1024;
        return Math.max(0.5, MIN_ZOOM_SPAN_HZ / bins);
    }

    // Hz/bin at full zoom-out (the whole 0–30 MHz view).
    fullSpanBinBandwidth() {
        if (this.defaultBinBandwidth > 0) return this.defaultBinBandwidth;
        if (this.initialBinBandwidth > 0) return this.initialBinBandwidth;
        return 30000000 / (this.defaultBinCount || this.binCount || 1024);
    }

    async connect(initial) {
        this.closedByUser = false;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        // One socket per connection, always — the audio socket carries the
        // reasoning, and this one is reached for more often: a tab that is
        // hidden and shown again suspends and resumes this socket and nothing
        // else, which is precisely where a second connect() during the
        // /connection check came from. The orphan it used to leave was silenced
        // by superseded() and never closed.
        if (this.ws || this.opening) return true;
        this.opening = true;

        // Spent here, whatever the check then answers: a re-registration that
        // was refused is not one to make again on the next attempt, and the
        // refusal itself is what settles whether there is a next attempt.
        const reregister = this.needsRegistration;
        this.needsRegistration = false;
        if (reregister) {
            this.emit('reregister', { message: 'Registering this session with the receiver again' });
        }
        const check = await connectionCheck({ reregister });
        // Cleared before anything can return, so every path out of here leaves
        // the flag matching reality: from here down either a socket is assigned
        // or there is none.
        this.opening = false;
        // Somebody let go while the check was in flight — the pause button, the
        // idle watch, a tab going to the background, powerOff. Without this the
        // socket opens anyway: disconnect() has already closed a socket that did
        // not exist yet and set closedByUser on a connection that is about to
        // clear it, leaving a spectrum that is paused on screen and streaming on
        // the wire. The DX cluster socket has always had this check.
        if (this.closedByUser) return false;
        if (!check.allowed) {
            // This used to stop here, full stop: no reconnect was scheduled for
            // any refusal, so a receiver that was momentarily full or a client
            // that had asked once too often left the waterfall blank until the
            // page was reloaded. Which refusals are worth waiting out is
            // lib/connectFailure.js.
            const fail = failureKind(check.reason, check.status);
            this._setState('rejected');
            this.emit('error', {
                kind: 'rejected', failure: fail, message: check.reason, status: check.status,
            });
            if (fail === 'retry') this._scheduleReconnect(initial);
            return false;
        }

        const q = new URLSearchParams({
            user_session_id: getSessionId(),
            mode: 'binary8',
        });
        const password = getBypassPassword();
        if (password) q.set('password', password);
        // Passing the view up front means a reconnect resumes at the current
        // zoom instead of snapping to the default span first.
        //
        // Clamped here as well as in setView, because this path does not go
        // through it — and because of what the server does with the pair: it
        // applies whichever of the two is given and keeps what it already had
        // for the other. A frequency with no bin bandwidth therefore lands on
        // the full-span default, so resuming at 1.19 MHz asks for a 30 MHz
        // window centred there and gets a left edge of -13.8 MHz back in the
        // first config.
        const initialBins = this.defaultBinCount || this.binCount;
        const initialSpan = initial && initial.binBandwidth > 0 && initialBins
            ? initial.binBandwidth * initialBins
            : 0;
        if (initial && initial.frequency > 0) {
            const centre = initialSpan > 0
                ? clampCenter(initial.frequency, initialSpan)
                : initial.frequency;
            q.set('frequency', String(Math.round(centre)));
        }
        if (initial && initial.binBandwidth > 0) q.set('bin_bandwidth', String(initial.binBandwidth));

        this._setState('connecting');
        let ws;
        try {
            ws = new WebSocket(`${wsBase()}/ws/user-spectrum?${q}`);
        } catch (err) {
            this.emit('error', { kind: 'open-failed', message: String(err) });
            this._scheduleReconnect(initial);
            return false;
        }
        ws.binaryType = 'arraybuffer';
        this.ws = ws;
        this.opened = false;
        this._lastInitial = initial;
        this.openedAt = Date.now();
        this.lastRxAt = this.openedAt;
        // An upgrade nothing answers is invisible to everything else here: the
        // reconnect hangs off onclose, and a socket that never opens never
        // closes. See socket-health.js.
        clearTimeout(this.handshakeTimer);
        this.handshakeTimer = setTimeout(() => {
            this.handshakeTimer = null;
            if (this.ws !== ws || this.opened) return;
            this._revive('handshake');
        }, HANDSHAKE_TIMEOUT_MS);

        // Events from a socket that has since been replaced, as the audio
        // socket has always had. Closing is not instant — the handshake
        // outlives the call — so a close-then-connect can land the old socket's
        // close event after the new one is live, where _onClose sets `this.ws =
        // null` and books a reconnect *on top of* a connection that is working.
        // The result is two sockets, one of them unreachable, and a spectrum
        // that pauses and comes back doubled. Now it also mattered for a second
        // reason: that stale close arrives with `opened` already cleared by the
        // connect below it, which reads as a refused handshake and spends a
        // re-registration on nothing.
        const superseded = () => this.ws && this.ws !== ws;

        ws.onopen = () => {
            if (superseded()) return;
            this.opened = true;
            clearTimeout(this.handshakeTimer);
            this.handshakeTimer = null;
            // Not refilled here — see the audio socket, which has the same
            // shape and the same reason. The spectrum session is created after
            // the upgrade too, so a refusal opens the socket first. _onFrame
            // refills it once bins actually arrive.
            this._setState('open');
            this.emit('open');
            // No keepalive timer. Every message touches the session server
            // side, ping included, so a timer here would make the session
            // immortal and the operator's slot unreclaimable. The idle watch
            // pings on activity instead — see radio/idle.js.
            //
            // The poll rate belongs to the socket that just went away, so a new
            // one starts at full rate whatever was asked for. Re-sent here or
            // the idle throttle lapses on every reconnect — silently, since
            // nothing reports the rate back and IdleWatch still believes it is
            // throttled. Only when it is not already 1: a fresh session is at
            // full rate anyway and the message would be noise.
            if (this.rateDivisor > 1) this.send({ type: 'set_rate', divisor: this.rateDivisor });
            if (this.pendingView) {
                const p = this.pendingView;
                this.pendingView = null;
                this.send({ type: 'zoom', ...p });
            }
        };
        ws.onmessage = (ev) => { if (!superseded()) this._onMessage(ev); };
        ws.onerror = () => {
            if (superseded()) return;
            this.emit('error', { kind: 'socket', message: 'spectrum socket error' });
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
    // back from being hidden, asleep or offline. It matters more here than
    // anywhere: this is the socket a hidden tab deliberately closes and reopens,
    // so it is the one most often in flight across a suspend.
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

    // A single message moves and rescales the view; the server treats "zoom"
    // and "pan" identically and applies whichever fields are present.
    //
    // A request made while the socket is down is remembered and replayed on the
    // next open, rather than being dropped: clicking a bookmark during a
    // reconnect used to tune the receiver and leave the view where it was, so
    // the signal you asked for was off screen with no sign of why.
    // The view is kept inside the band here rather than at each call site.
    //
    // There are eight callers and only the three zoom ones remembered to do it:
    // panning, ensureVisible, centerOnTuned and the auto-recentre all clamp the
    // centre to MIN_FREQ..MAX_FREQ, which says nothing about where the *edges*
    // land — a centre of 10 kHz with a 1 MHz span puts the left edge at
    // -490 kHz. Worse, setSpan passes no centre at all: a wider span can put an
    // untouched centre out of bounds on its own, so there is a case here that
    // no call site could have fixed. The result was a spectrum running past
    // 0 Hz into frequencies that do not exist, most easily on a low frequency
    // with the zoom anchored to the dial.
    //
    // clampCenter is the same rule the zoom actions already use: the left edge
    // stops at 0 and the right at MAX_FREQ, and a span too small to reach
    // either simply keeps the centre inside the band.
    setView(centerFreq, binBandwidth) {
        const bw = binBandwidth != null ? binBandwidth : this.binBandwidth;
        const span = bw > 0 && this.binCount > 0 ? bw * this.binCount : 0;
        const wanted = centerFreq != null ? centerFreq : this.centerFreq;
        const centre = span > 0 && wanted > 0 ? clampCenter(wanted, span) : wanted;

        const msg = { type: 'zoom' };
        // The centre goes out when the caller asked for one, and also when the
        // clamp has moved a centre nobody touched — which is the span-change
        // case above.
        if (centerFreq != null || (centre > 0 && Math.round(centre) !== Math.round(this.centerFreq))) {
            msg.frequency = Math.round(centre);
        }
        if (binBandwidth != null) msg.binBandwidth = binBandwidth;
        if (this.send(msg)) return true;
        this.pendingView = {
            ...(this.pendingView || {}),
            ...(msg.frequency != null ? { frequency: msg.frequency } : {}),
            ...(msg.binBandwidth != null ? { binBandwidth: msg.binBandwidth } : {}),
        };
        return false;
    }

    reset() {
        return this.send({ type: 'reset' });
    }

    // divisor 1..8 — reduces how often the server polls, for slow links.
    //
    // The value is kept and published with the view geometry so the Status panel
    // can show what rate the spectrum is running at: it is the one setting here
    // that nothing on screen would otherwise reveal, and it changes on its own
    // (IdleWatch halves it after a few minutes of nothing).
    //
    // Kept even when the send fails. A socket that is down has no rate at all,
    // and what the panel should say once it comes back is what was last asked
    // for, not "full" — the server clamps to 1..8 and so does this, so the two
    // cannot drift.
    setRate(divisor) {
        const d = Math.min(8, Math.max(1, Math.round(Number(divisor) || 1)));
        const changed = d !== this.rateDivisor;
        this.rateDivisor = d;
        const ok = this.send({ type: 'set_rate', divisor: d });
        if (changed) this.emit('config', this._config());
        return ok;
    }

    // ---- internals ------------------------------------------------------

    // What the view looks like from outside: the server's geometry, plus the
    // rate this client asked for. One shape, built in one place, so a field
    // added for the panel cannot go missing from whichever emitter forgot it.
    // Timers that belong to the socket in hand rather than to the connection.
    _disarm() {
        clearTimeout(this.handshakeTimer);
        clearTimeout(this._probeTimer);
        this.handshakeTimer = null;
        this._probeTimer = null;
    }

    // Let go of a socket that will never say anything for itself — a handshake
    // nothing answered, or one left half-open by a machine that went to sleep.
    // The close is reported from here because abandon() detaches the handlers,
    // and it has to: a browser that eventually notices the dead connection would
    // otherwise land its close on whatever socket has replaced this one.
    _revive(reason) {
        const ws = this.ws;
        if (!ws) return;
        this._disarm();
        abandon(ws);
        this.ws = null;
        this.opened = false;
        this.emit('close', { code: 1006, reason, failure: null });
        if (this.closedByUser) {
            this._setState('idle');
            return;
        }
        // At the live view, as the reconnect timer does — a socket that dies
        // while the tab is away must not come back at the default span.
        this._scheduleReconnect({ frequency: this.centerFreq, binBandwidth: this.binBandwidth });
    }

    _config() {
        return {
            centerFreq: this.centerFreq,
            binCount: this.binCount,
            binBandwidth: this.binBandwidth,
            span: this.span,
            defaultBinCount: this.defaultBinCount,
            defaultBinBandwidth: this.defaultBinBandwidth,
            rateDivisor: this.rateDivisor,
        };
    }

    // Puts the view back inside the band when the server reports one that is not.
    //
    // The server pairs a frequency with whatever zoom the session already had
    // and validates neither against the other, so it will report a 30 MHz span
    // centred on 1.19 MHz without complaint. That view cannot be drawn — the
    // ruler runs to -13.8 MHz and there are no bins there — and the client is
    // the only party that notices, so it asks for the corrected centre.
    //
    // Once per bad centre: were the server to insist on the same impossible
    // view, this would otherwise ask again for every config it sent back.
    _correctOutOfBand() {
        if (!this.span || !this.centerFreq) return;
        const fixed = clampCenter(this.centerFreq, this.span);
        if (Math.round(fixed) === Math.round(this.centerFreq)) {
            this._corrected = 0;
            return;
        }
        if (this._corrected === Math.round(this.centerFreq)) return;
        this._corrected = Math.round(this.centerFreq);
        console.warn('[spectrum] server reported a view outside the band —'
            + ` centre ${this.centerFreq} with a ${this.span} Hz span puts the edge at`
            + ` ${this.centerFreq - this.span / 2}; asking for ${fixed}`);
        this.setView(fixed, null);
    }

    _setState(state) {
        if (this.state === state) return;
        this.state = state;
        this.emit('state', state);
    }

    async _onMessage(ev) {
        // Any frame at all, pong included: what this timestamp answers is
        // whether the server is still there, not whether it said anything
        // interesting.
        this.lastRxAt = Date.now();
        this.bytesIn += frameSize(ev.data);
        if (!(ev.data instanceof ArrayBuffer)) {
            try { this._onControl(JSON.parse(ev.data)); } catch (e) { /* ignore */ }
            return;
        }
        const buf = ev.data;
        if (buf.byteLength >= 4) {
            const head = new Uint8Array(buf, 0, 4);
            if (head[0] === 0x53 && head[1] === 0x50 && head[2] === 0x45 && head[3] === 0x43) {
                this._onSpectrum(new DataView(buf));
                return;
            }
        }
        // Control messages travel gzipped as binary frames.
        try {
            const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
            const text = await new Response(stream).text();
            this._onControl(JSON.parse(text));
        } catch (err) {
            console.error('spectrum: failed to decode control frame', err);
        }
    }

    _onControl(msg) {
        if (!msg) return;
        if (msg.type === 'config' || msg.type === 'status') {
            if (msg.centerFreq) this.centerFreq = msg.centerFreq;
            if (msg.binCount) this.binCount = msg.binCount;
            if (msg.binBandwidth) {
                this.binBandwidth = msg.binBandwidth;
                if (!this.initialBinBandwidth) this.initialBinBandwidth = msg.binBandwidth;
            }
            if (msg.defaultBinCount) this.defaultBinCount = msg.defaultBinCount;
            if (msg.defaultBinBandwidth) this.defaultBinBandwidth = msg.defaultBinBandwidth;
            // Bin count changes invalidate the delta accumulators.
            if (this._float && this._float.length !== this.binCount) this._float = null;
            if (this._u8 && this._u8.length !== this.binCount) this._u8 = null;
            this._correctOutOfBand();
            this.emit('config', this._config());
            return;
        }
        if (msg.type === 'error') {
            // Sent after the upgrade and followed by a close — the spectrum
            // session is created once the socket is already up, so this is
            // where a creation rate limit or a reclaimed session lands. Held
            // for _onClose, which otherwise cannot tell that close from any
            // other. See the audio socket, which does the same.
            this.lastFailure = failureKind(msg.error, msg.status);
            this.emit('error', {
                kind: 'server', failure: this.lastFailure, message: msg.error, status: msg.status,
            });
            return;
        }
        if (msg.type === 'pong') return;
        this.emit('message', msg);
    }

    _onSpectrum(view) {
        if (view.getUint8(4) !== 0x01) return;   // protocol version
        const flags = view.getUint8(5);
        const timestamp = Number(view.getBigUint64(6, true));
        const frequency = Number(view.getBigUint64(14, true));

        let bins = null;

        if (flags === 0x01) {
            const n = (view.byteLength - HEADER_BYTES) / 4;
            const out = new Float32Array(n);
            for (let i = 0; i < n; i++) out[i] = view.getFloat32(HEADER_BYTES + i * 4, true);
            this._float = out;
            this._u8 = null;
            bins = out;
        } else if (flags === 0x02) {
            if (!this._float) return;            // delta before any full frame
            const count = view.getUint16(HEADER_BYTES, true);
            let off = HEADER_BYTES + 2;
            for (let i = 0; i < count; i++) {
                this._float[view.getUint16(off, true)] = view.getFloat32(off + 2, true);
                off += 6;
            }
            bins = this._float;
        } else if (flags === 0x03) {
            const n = view.byteLength - HEADER_BYTES;
            const u8 = new Uint8Array(n);
            const out = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                const v = view.getUint8(HEADER_BYTES + i);
                u8[i] = v;
                out[i] = v - 256;                // 0 => -256 dB, 255 => -1 dB
            }
            this._u8 = u8;
            this._float = out;
            bins = out;
        } else if (flags === 0x04) {
            if (!this._u8 || !this._float) return;
            const count = view.getUint16(HEADER_BYTES, true);
            let off = HEADER_BYTES + 2;
            for (let i = 0; i < count; i++) {
                const idx = view.getUint16(off, true);
                const v = view.getUint8(off + 2);
                this._u8[idx] = v;
                this._float[idx] = v - 256;
                off += 3;
            }
            bins = this._float;
        } else {
            return;
        }

        this.framesIn++;
        // Bins on the wire: this session exists and is producing, which is the
        // proof the reconnect budget waits for rather than the bare open event.
        this.attempts = 0;
        this.emit('frame', { bins: this._unwrap(bins), frequency, timestamp });
    }

    // Rotates raw FFT order into ascending frequency order: the second half
    // (negative frequencies) moves to the front. A plain rotate-left by
    // floor(n/2), so odd bin counts stay correct rather than dropping a bin.
    _unwrap(raw) {
        const n = raw.length;
        if (!this._out || this._out.length !== n) this._out = new Float32Array(n);
        const half = n >> 1;
        this._out.set(raw.subarray(half), 0);
        this._out.set(raw.subarray(0, half), n - half);
        return this._out;
    }

    _onClose(ev) {
        this.ws = null;
        this._disarm();
        const failure = this.lastFailure;
        this.lastFailure = null;
        const opened = this.opened;
        this.opened = false;
        // The code goes out with it, as the audio socket's does: 1000 is a
        // deliberate close and 1006 is the connection being torn out, and
        // nothing else on screen distinguishes them.
        this.emit('close', { code: ev && ev.code, failure });
        if (this.closedByUser) {
            this._setState('idle');
            return;
        }
        // A refusal the server explained a moment ago settles whether to try
        // again — see _onMessage. Without it every refusal looked like a
        // dropped connection and was retried on the same curve for ever,
        // including the ones that can never succeed.
        if (failure && failure !== 'retry' && failure !== 'reregister') {
            this._setState('idle');
            return;
        }
        // Nothing was ever open, and nothing was said. That is what a refused
        // upgrade looks like from here: this endpoint answers an unregistered
        // id with a 400 before it upgrades, and the browser hands us a bare
        // 1006 for it — the same event a pulled network cable produces. Of the
        // two, only one is ours to mend, so the next attempt asks /connection
        // which of them it was. One POST per outage: the flag is spent by that
        // attempt and only set again by another close that never opened.
        if (failure === 'reregister' || !opened) this.needsRegistration = true;
        this._scheduleReconnect(this._lastInitial);
    }

    _scheduleReconnect(initial) {
        if (this.reconnectTimer || this.closedByUser) return;
        if (this.attempts >= this.maxAttempts) {
            this._setState('idle');
            // See the audio socket's give-up: a session this far gone is
            // replaced rather than reloaded.
            this.emit('error', {
                kind: 'give-up',
                failure: 'identity',
                message: 'Lost the spectrum connection and could not get it back.',
            });
            return;
        }
        const delay = Math.min(30000, 1000 * Math.pow(1.6, this.attempts));
        this.attempts++;
        this._setState('reconnecting');
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            // Resume at the live view rather than whatever we first connected with.
            this.connect({ frequency: this.centerFreq, binBandwidth: this.binBandwidth });
        }, delay);
    }
}
