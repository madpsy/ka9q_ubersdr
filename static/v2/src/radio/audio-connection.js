// Audio WebSocket client (/ws).
//
// Wire format, requested as `format=opus&version=2`:
//
//   binary frame: [timestamp u64][sampleRate u32][channels u8]
//                 [basebandPower f32][noiseDensity f32][opus payload...]
//   text frame:   JSON control messages (status / error / pong / agc_state ...)
//
// The server falls back to JSON `audio` messages (base64 PCM) when Opus is
// unavailable; that path is handled too so the UI still works on such a server.

import { Emitter } from './emitter.js';
import {
    connectionCheck, frameSize, getBypassPassword, getSessionId, setServerSessionId, wsBase,
} from './session.js';

// Version 2 header: timestamp(8) sampleRate(4) channels(1) power(4) noise(4).
const HEADER_BYTES = 21;

export class AudioConnection extends Emitter {
    constructor() {
        super();
        this.ws = null;
        this.state = 'idle';        // idle | connecting | open | reconnecting | rejected
        this.params = null;         // last successful connect params, for reconnect
        this.closedByUser = false;
        this.attempts = 0;
        this.maxAttempts = 12;
        this.reconnectTimer = null;
        this.pingTimer = null;
        // Bytes taken off this socket, ever. Cumulative and never reset, so a
        // reader only has to take deltas — see the Receiver info panel, which
        // is the only thing that looks at it.
        this.bytesIn = 0;
    }

    get connected() {
        return this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    async connect(params) {
        this.closedByUser = false;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.params = { ...params };

        const check = await connectionCheck();
        if (!check.allowed) {
            this._setState('rejected');
            this.emit('error', { kind: 'rejected', message: check.reason });
            // Server-side capacity limits clear on their own; bans do not.
            if (/maximum/i.test(check.reason)) this._scheduleReconnect();
            return false;
        }

        const q = new URLSearchParams({
            frequency: String(Math.round(params.frequency)),
            mode: params.mode,
            bandwidthLow: String(Math.round(params.bandwidthLow)),
            bandwidthHigh: String(Math.round(params.bandwidthHigh)),
            user_session_id: getSessionId(),
            format: 'opus',
            version: '2',
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

        ws.onopen = () => {
            this.attempts = 0;
            this._setState('open');
            this.emit('open');
            // The server sends no unsolicited status for binary audio formats,
            // so ask for one — the UI should reflect what the server actually
            // tuned, not only what we requested.
            this.send({ type: 'get_status' });
            clearInterval(this.pingTimer);
            this.pingTimer = setInterval(() => this.send({ type: 'ping' }), 15000);
        };
        ws.onmessage = (ev) => this._onMessage(ev);
        ws.onerror = () => this.emit('error', { kind: 'socket', message: 'audio socket error' });
        ws.onclose = (ev) => this._onClose(ev);
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

    _onMessage(ev) {
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
            this.emit('error', { kind: 'server', message: msg.error, status: msg.status });
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
            this.emit('pcm', { planes, sampleRate: msg.sampleRate || 12000, channels });
            return;
        }
        this.emit('message', msg);
    }

    _onBinary(buffer) {
        // The header layout is fixed by the `version=2` we request at connect
        // time, so it can be parsed unconditionally.
        if (buffer.byteLength <= HEADER_BYTES) return;
        const view = new DataView(buffer);
        const sampleRate = view.getUint32(8, true);
        const channels = view.getUint8(12) || 1;

        let basebandPower = view.getFloat32(13, true);
        let noiseDensity = view.getFloat32(17, true);
        // -999 is the server's "no channel status available" sentinel.
        if (!(basebandPower > -998)) basebandPower = null;
        if (!(noiseDensity > -998)) noiseDensity = null;
        this.emit('quality', { basebandPower, noiseDensity });

        this.emit('opus', {
            data: new Uint8Array(buffer, HEADER_BYTES),
            sampleRate,
            channels,
        });
    }

    _onClose(ev) {
        clearInterval(this.pingTimer);
        this.ws = null;
        // The session it belonged to is gone; a reconnect is given a new one.
        setServerSessionId(null);
        this.emit('close', { code: ev.code, reason: ev.reason });
        if (this.closedByUser || ev.code === 1000 || ev.code === 1001) {
            this._setState('idle');
            return;
        }
        this._scheduleReconnect();
    }

    _scheduleReconnect() {
        if (this.reconnectTimer || !this.params || this.closedByUser) return;
        if (this.attempts >= this.maxAttempts) {
            this._setState('idle');
            this.emit('error', { kind: 'give-up', message: 'Unable to reconnect — reload the page.' });
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
