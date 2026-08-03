// The `/ws/dxcluster` client.
//
// Despite the name this socket is a multiplexer, not a DX cluster feed: it
// carries DX spots, digital-mode spots, CW skimmer spots and chat, each opted
// into separately, and the v1 extensions also run their audio-decoder control
// and results over it. Nothing arrives until the matching `subscribe_*` has
// been sent — the server answers "you must subscribe to chat first" otherwise —
// and that subscription is also what replays the server's recent buffer.
//
// So this is one shared connection with reference-counted subscriptions rather
// than a socket per feature. Each consumer calls `acquire(stream)` and gets a
// release function; the socket opens on the first acquire and closes on the
// last release. That matters beyond tidiness: the server counts sockets per
// session, and a panel per stream would mean three connections carrying three
// copies of the chat traffic.
//
// Client -> server
//   subscribe_dx_spots / subscribe_digital_spots / subscribe_cw_spots
//   subscribe_chat  (+ the unsubscribe_* of each)
//   chat_set_username {username}      1-15 chars, alphanumeric plus - _ /
//   chat_message {message}
//   chat_set_frequency_mode {frequency, mode, bw_low, bw_high}
//   chat_request_users / chat_leave / ping
//
// Server -> client
//   dx_spot / digital_spot / cw_spot   {data:{…}}   — see lib/spots.js
//   chat_message        {data:{username, message, timestamp}}
//   chat_user_joined    {data:{username, timestamp, country, country_code}}
//   chat_user_left      {data:{username, ...}}
//   chat_active_users   {data:{users[], count}}
//   chat_user_update    {data:{...}}
//   chat_idle_updates   {data:{users[]}}
//   chat_error          {error}
//   subscription_status {stream, enabled}

import { Emitter } from './emitter.js';
import { connectionCheck, getBypassPassword, getSessionId, wsBase } from './session.js';

export const USERNAME_MAX = 15;

// Stream names as the server spells them in `subscribe_*` and in the
// `subscription_status` replies.
export const STREAMS = ['dx_spots', 'digital_spots', 'cw_spots', 'chat'];

// Mirrors isAlphanumeric() server-side: letters, digits, and - _ / but never
// leading or trailing. Checked here so a bad name is caught before a round trip.
export function validateUsername(name) {
    const n = String(name || '');
    if (n.length === 0) return 'Enter a name';
    if (n.length > USERNAME_MAX) return `At most ${USERNAME_MAX} characters`;
    if (!/^[A-Za-z0-9]([A-Za-z0-9\-_/]*[A-Za-z0-9])?$/.test(n)) {
        return 'Letters, digits, - _ / only, not at the ends';
    }
    return null;
}

export class DXClusterConnection extends Emitter {
    constructor() {
        super();
        this.ws = null;
        this.state = 'idle';
        this.closedByUser = false;
        this.attempts = 0;
        this.maxAttempts = 12;
        this.reconnectTimer = null;
        this.pingTimer = null;
        this.username = null;      // replayed on reconnect
        this.lastStatus = null;    // frequency/mode, likewise
        // How many consumers want each stream. Sending a subscribe per consumer
        // would be harmless, but the unsubscribe would not: the first panel to
        // close would cut off every other one.
        this.refs = Object.fromEntries(STREAMS.map((s) => [s, 0]));
        this.confirmed = Object.fromEntries(STREAMS.map((s) => [s, false]));
        this.opening = false;
    }

    get connected() {
        return this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    wants(stream) {
        return this.refs[stream] > 0;
    }

    // Registers interest in a stream and returns the matching release.
    //
    // Demand is the *only* thing that opens the socket: acquire when you
    // actually want data — the panel is visible and the receiver is running —
    // and release when you do not. There is deliberately no separate "connect"
    // for a caller to get out of step with.
    acquire(stream) {
        if (!(stream in this.refs)) throw new Error(`unknown stream: ${stream}`);
        this.refs[stream] += 1;
        if (this.refs[stream] === 1 && this.connected) this._subscribe(stream);
        this._sync();
        let released = false;
        return () => {
            if (released) return;      // a double release must not go negative
            released = true;
            this.refs[stream] -= 1;
            if (this.refs[stream] > 0) return;
            this.confirmed[stream] = false;
            if (this.connected) this.send({ type: `unsubscribe_${stream}` });
            this._sync();
        };
    }

    // Opens or closes to match demand. The last release closes the socket
    // rather than leaving an idle connection counted against the session.
    _sync() {
        const wanted = STREAMS.some((s) => this.wants(s));
        if (wanted) this.connect();
        else if (this.ws || this.reconnectTimer || this.opening) this.disconnect();
    }

    async connect() {
        this.closedByUser = false;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        // `ws` is only assigned after the await below, so a second call while
        // the connection check is in flight would open a second socket.
        if (this.ws || this.opening) return true;
        this.opening = true;

        const check = await connectionCheck();
        this.opening = false;
        if (!check.allowed) {
            this._setState('rejected');
            this.emit('error', { message: check.reason });
            return false;
        }
        // Everyone may have let go while the check was in flight.
        if (this.closedByUser || !STREAMS.some((s) => this.wants(s))) return false;

        const q = new URLSearchParams({ user_session_id: getSessionId() });
        const password = getBypassPassword();
        if (password) q.set('password', password);

        this._setState('connecting');
        let ws;
        try {
            ws = new WebSocket(`${wsBase()}/ws/dxcluster?${q}`);
        } catch (err) {
            this.emit('error', { message: String(err) });
            this._scheduleReconnect();
            return false;
        }
        this.ws = ws;

        ws.onopen = () => {
            this.attempts = 0;
            this._setState('open');
            // Subscribing is what makes the socket carry anything at all, and
            // replays each stream's buffered history. Everything else waits for
            // the server's confirmation — sending straight after this races the
            // server registering the subscription, and anything that arrives
            // first is refused.
            for (const stream of STREAMS) if (this.wants(stream)) this._subscribe(stream);
            clearInterval(this.pingTimer);
            this.pingTimer = setInterval(() => this.send({ type: 'ping' }), 20000);
            this.emit('open');
        };
        ws.onmessage = (ev) => {
            // Binary frames belong to the audio-extension decoders, which will
            // attach their own listener to `ws` directly. Ignored here rather
            // than fed to JSON.parse.
            if (typeof ev.data !== 'string') return;
            let msg;
            try { msg = JSON.parse(ev.data); } catch (e) { return; }
            this._onMessage(msg);
        };
        ws.onerror = () => this.emit('error', { message: 'dxcluster socket error' });
        ws.onclose = () => this._onClose();
        return true;
    }

    disconnect() {
        this.closedByUser = true;
        this.opening = false;
        clearTimeout(this.reconnectTimer);
        clearInterval(this.pingTimer);
        this.reconnectTimer = null;
        if (this.connected && this.username) this.send({ type: 'chat_leave' });
        if (this.ws) {
            try { this.ws.close(1000, 'client'); } catch (e) { /* ignore */ }
        }
        this.ws = null;
        for (const stream of STREAMS) this.confirmed[stream] = false;
        this._setState('idle');
    }

    send(msg) {
        if (!this.connected) return false;
        this.ws.send(JSON.stringify(msg));
        return true;
    }

    // ---- chat -----------------------------------------------------------

    setUsername(username) {
        this.username = username;
        return this.send({ type: 'chat_set_username', username });
    }

    sendMessage(message) {
        return this.send({ type: 'chat_message', message });
    }

    // Publishes what this receiver is listening to, so other users see it
    // beside our name.
    setStatus({ frequency, mode, bandwidthLow, bandwidthHigh }) {
        this.lastStatus = {
            frequency: Math.round(frequency),
            mode,
            bw_low: Math.round(bandwidthLow),
            bw_high: Math.round(bandwidthHigh),
        };
        return this.send({ type: 'chat_set_frequency_mode', ...this.lastStatus });
    }

    requestUsers() {
        return this.send({ type: 'chat_request_users' });
    }

    leave() {
        this.username = null;
        return this.send({ type: 'chat_leave' });
    }

    // ---- internals ------------------------------------------------------

    _subscribe(stream) {
        this.send({ type: `subscribe_${stream}` });
    }

    _setState(state) {
        if (this.state === state) return;
        this.state = state;
        this.emit('state', state);
    }

    _onMessage(msg) {
        const d = msg.data || {};
        switch (msg.type) {
            // Spot streams. Emitted with the server's payload untouched;
            // lib/spots.js is the only place their shapes are interpreted.
            case 'dx_spot':
                this.emit('dx_spot', d);
                break;
            case 'digital_spot':
                this.emit('digital_spot', d);
                break;
            case 'cw_spot':
                this.emit('cw_spot', d);
                break;

            case 'chat_message':
                this.emit('message', {
                    username: d.username,
                    message: d.message,
                    timestamp: d.timestamp,
                });
                break;
            case 'chat_user_joined':
                this.emit('presence', { kind: 'joined', ...d });
                break;
            case 'chat_user_left':
                this.emit('presence', { kind: 'left', ...d });
                break;
            case 'chat_active_users':
                this.emit('users', { users: d.users || [], count: d.count || 0 });
                break;
            case 'chat_user_update':
                this.emit('userUpdate', d);
                break;
            case 'chat_idle_updates':
                this.emit('idle', d.users || []);
                break;
            case 'chat_error':
                this.emit('error', { message: msg.error });
                break;
            case 'subscription_status': {
                const stream = msg.stream;
                if (!(stream in this.confirmed)) break;
                this.confirmed[stream] = !!msg.enabled;
                if (stream === 'chat' && msg.enabled) {
                    // Safe to talk now. A reconnect must restore identity and
                    // status, or the user silently reverts to anonymous.
                    if (this.username) this.send({ type: 'chat_set_username', username: this.username });
                    if (this.lastStatus) this.send({ type: 'chat_set_frequency_mode', ...this.lastStatus });
                    this.send({ type: 'chat_request_users' });
                }
                this.emit('subscribed', { stream, enabled: !!msg.enabled });
                break;
            }
            default:
                break;   // pong, and the audio-extension replies
        }
    }

    _onClose() {
        clearInterval(this.pingTimer);
        this.ws = null;
        for (const stream of STREAMS) this.confirmed[stream] = false;
        this.emit('close');
        if (this.closedByUser) {
            this._setState('idle');
            return;
        }
        this._scheduleReconnect();
    }

    _scheduleReconnect() {
        if (this.reconnectTimer || this.closedByUser) return;
        if (this.attempts >= this.maxAttempts) {
            this._setState('idle');
            return;
        }
        const delay = Math.min(30000, 1000 * Math.pow(1.6, this.attempts));
        this.attempts++;
        this._setState('reconnecting');
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }
}

// The one connection, shared by chat, the spots panel, and whatever else comes
// to ride this socket. A module singleton for the same reason the control
// sources are: consumers mount and unmount as their panels are dragged between
// docks, and the socket must not follow them.
export const dxcluster = new DXClusterConnection();
