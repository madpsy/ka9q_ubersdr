// Chat client.
//
// Chat is not its own endpoint: it is multiplexed onto `/ws/dxcluster`
// alongside DX/digital/CW spot streams, each of which is opted into
// separately. Nothing chat-related is accepted until `subscribe_chat` has been
// sent — the server replies "you must subscribe to chat first" otherwise — and
// that subscription is also what replays the recent-message buffer.
//
// Client -> server
//   subscribe_chat / unsubscribe_chat
//   chat_set_username {username}      1-15 chars, alphanumeric plus - _ /
//   chat_message {message}
//   chat_set_frequency_mode {frequency, mode, bw_low, bw_high}
//   chat_request_users
//   chat_leave
//   ping
//
// Server -> client
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

export class ChatConnection extends Emitter {
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
    }

    get connected() {
        return this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    async connect() {
        this.closedByUser = false;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        if (this.ws) return true;

        const check = await connectionCheck();
        if (!check.allowed) {
            this._setState('rejected');
            this.emit('error', { message: check.reason });
            return false;
        }

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
            // Subscribing is what makes the socket a chat socket, and replays
            // the buffered history. Everything else waits for the server's
            // confirmation — sending straight after this races the server
            // registering the subscription, and anything that arrives first is
            // refused with "you must subscribe to chat first".
            this.send({ type: 'subscribe_chat' });
            clearInterval(this.pingTimer);
            this.pingTimer = setInterval(() => this.send({ type: 'ping' }), 20000);
            this.emit('open');
        };
        ws.onmessage = (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch (e) { return; }
            this._onMessage(msg);
        };
        ws.onerror = () => this.emit('error', { message: 'chat socket error' });
        ws.onclose = () => this._onClose();
        return true;
    }

    disconnect() {
        this.closedByUser = true;
        clearTimeout(this.reconnectTimer);
        clearInterval(this.pingTimer);
        this.reconnectTimer = null;
        if (this.connected) this.send({ type: 'chat_leave' });
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

    _setState(state) {
        if (this.state === state) return;
        this.state = state;
        this.emit('state', state);
    }

    _onMessage(msg) {
        const d = msg.data || {};
        switch (msg.type) {
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
            case 'subscription_status':
                if (msg.stream !== 'chat') break;
                if (msg.enabled) {
                    // Safe to talk now. A reconnect must restore identity and
                    // status, or the user silently reverts to anonymous.
                    if (this.username) this.send({ type: 'chat_set_username', username: this.username });
                    if (this.lastStatus) this.send({ type: 'chat_set_frequency_mode', ...this.lastStatus });
                    this.send({ type: 'chat_request_users' });
                }
                this.emit('subscribed', !!msg.enabled);
                break;
            default:
                break;   // spot streams we never subscribed to
        }
    }

    _onClose() {
        clearInterval(this.pingTimer);
        this.ws = null;
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
