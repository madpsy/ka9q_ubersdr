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
import { connectionCheck, getBypassPassword, getSessionId, wsBase } from './session.js';

const HEADER_BYTES = 22;

// Narrowest span (Hz) the normal zoom controls will reach. Matches v1's
// MIN_ZOOM_SPAN_HZ so both frontends stop at the same place. It is a *span*,
// not a Hz/bin value, so zoom depth does not change with spectrum.bin_count.
// The server allows down to 0.5 Hz/bin for explicit requests.
const MIN_ZOOM_SPAN_HZ = 10240;

export class SpectrumConnection extends Emitter {
    constructor() {
        super();
        this.ws = null;
        this.state = 'idle';
        this.closedByUser = false;
        this.attempts = 0;
        this.maxAttempts = 12;
        this.reconnectTimer = null;
        this.pingTimer = null;

        // Server-reported view geometry, from the `config` message.
        this.centerFreq = 0;
        this.binCount = 0;
        this.binBandwidth = 0;
        this.defaultBinCount = 0;
        this.defaultBinBandwidth = 0;
        this.initialBinBandwidth = 0;   // first value seen, i.e. the full-span view

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

        const check = await connectionCheck();
        if (!check.allowed) {
            this._setState('rejected');
            this.emit('error', { kind: 'rejected', message: check.reason });
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
        if (initial && initial.frequency > 0) q.set('frequency', String(Math.round(initial.frequency)));
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
        this._lastInitial = initial;

        ws.onopen = () => {
            this.attempts = 0;
            this._setState('open');
            this.emit('open');
            clearInterval(this.pingTimer);
            this.pingTimer = setInterval(() => this.send({ type: 'ping' }), 20000);
        };
        ws.onmessage = (ev) => this._onMessage(ev);
        ws.onerror = () => this.emit('error', { kind: 'socket', message: 'spectrum socket error' });
        ws.onclose = () => this._onClose();
        return true;
    }

    disconnect() {
        this.closedByUser = true;
        clearTimeout(this.reconnectTimer);
        clearInterval(this.pingTimer);
        this.reconnectTimer = null;
        if (this.ws) {
            try { this.ws.close(1000, 'client'); } catch (e) { /* ignore */ }
        }
        this.ws = null;
        this._setState('idle');
    }

    send(msg) {
        if (!this.connected) return false;
        this.ws.send(JSON.stringify(msg));
        return true;
    }

    // ---- commands -------------------------------------------------------

    // A single message moves and rescales the view; the server treats "zoom"
    // and "pan" identically and applies whichever fields are present.
    setView(centerFreq, binBandwidth) {
        const msg = { type: 'zoom' };
        if (centerFreq != null) msg.frequency = Math.round(centerFreq);
        if (binBandwidth != null) msg.binBandwidth = binBandwidth;
        return this.send(msg);
    }

    reset() {
        return this.send({ type: 'reset' });
    }

    // divisor 1..8 — reduces how often the server polls, for slow links.
    setRate(divisor) {
        return this.send({ type: 'set_rate', divisor });
    }

    // ---- internals ------------------------------------------------------

    _setState(state) {
        if (this.state === state) return;
        this.state = state;
        this.emit('state', state);
    }

    async _onMessage(ev) {
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
            this.emit('config', {
                centerFreq: this.centerFreq,
                binCount: this.binCount,
                binBandwidth: this.binBandwidth,
                span: this.span,
                defaultBinCount: this.defaultBinCount,
                defaultBinBandwidth: this.defaultBinBandwidth,
            });
            return;
        }
        if (msg.type === 'error') {
            this.emit('error', { kind: 'server', message: msg.error, status: msg.status });
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

    _onClose() {
        clearInterval(this.pingTimer);
        this.ws = null;
        this.emit('close');
        if (this.closedByUser) {
            this._setState('idle');
            return;
        }
        this._scheduleReconnect(this._lastInitial);
    }

    _scheduleReconnect(initial) {
        if (this.reconnectTimer || this.closedByUser) return;
        if (this.attempts >= this.maxAttempts) {
            this._setState('idle');
            this.emit('error', { kind: 'give-up', message: 'Spectrum reconnect failed — reload the page.' });
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
