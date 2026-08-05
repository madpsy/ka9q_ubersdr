// The `/ws/dxcluster` client.
//
// Despite the name this socket is a multiplexer, not a DX cluster feed: it
// carries DX spots, digital-mode spots, CW skimmer spots and chat, each opted
// into separately, and the audio-extension decoders run their control messages
// and their results over it too. Nothing arrives until the matching
// `subscribe_*` has been sent — the server answers "you must subscribe to chat
// first" otherwise — and that subscription is also what replays the server's
// recent buffer.
//
// So this is one shared connection with reference-counted subscriptions rather
// than a socket per feature. Each consumer calls `acquire(stream)` and gets a
// release function; the socket opens on the first acquire and closes on the
// last release. That matters beyond tidiness: the server counts sockets per
// session, and a panel per stream would mean three connections carrying three
// copies of the chat traffic.
//
// Audio extensions have nothing to subscribe to — their traffic is the
// attach/detach control messages and the binary result frames that come back —
// so they call `hold()` instead, which keeps the socket open on the same
// reference count without asking for a stream.
//
// Client -> server
//   subscribe_dx_spots / subscribe_digital_spots / subscribe_cw_spots
//   subscribe_chat / subscribe_freedv_activity  (+ the unsubscribe_* of each)
//   chat_set_username {username}      1-15 chars, alphanumeric plus - _ /
//   chat_message {message}
//   chat_set_frequency_mode {frequency, mode, bw_low, bw_high}
//   chat_request_users / chat_leave / ping
//
// Server -> client
//   dx_spot / digital_spot / cw_spot   {data:{…}}   — see lib/spots.js
//   freedv_activity_snapshot {users[]} / freedv_activity_update {event,user|sid}
//   chat_message        {data:{username, message, timestamp}}
//   chat_user_joined    {data:{username, timestamp, country, country_code}}
//   chat_user_left      {data:{username, ...}}
//   chat_active_users   {data:{users[], count}}
//   chat_user_update    {data:{...}}
//   chat_idle_updates   {data:{users[]}}
//   chat_error          {error}
//   subscription_status {stream, enabled}
//
// Audio extensions (see extensions/protocol.js for the message shapes)
//   client -> server  audio_extension_attach / _detach / _control / _status
//   server -> client  audio_extension_attached / _detached / _error / _status
//                     plus one binary frame per decoder result

import { Emitter } from './emitter.js';
import { connectionCheck, getBypassPassword, getSessionId, wsBase } from './session.js';

export const USERNAME_MAX = 15;

// Stream names as the server spells them in `subscribe_*` and in the
// `subscription_status` replies.
export const STREAMS = ['dx_spots', 'digital_spots', 'cw_spots', 'chat', 'freedv_activity'];

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
        // Whether this socket has already been told who we are. The replay
        // below is per *socket*, not per subscription confirmation, and the two
        // are not the same thing — see _onMessage.
        this.identitySent = false;
        // How many consumers want each stream. Sending a subscribe per consumer
        // would be harmless, but the unsubscribe would not: the first panel to
        // close would cut off every other one.
        this.refs = Object.fromEntries(STREAMS.map((s) => [s, 0]));
        this.confirmed = Object.fromEntries(STREAMS.map((s) => [s, false]));
        // Consumers that want the socket but no stream — see hold().
        this.holds = 0;
        this.opening = false;
        // The session UUID this socket was opened with — see `stale`.
        this.openedWith = null;
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

    // Keeps the socket open without subscribing to anything, for consumers
    // whose traffic is not a stream: the audio extensions send an attach and
    // read the frames that come back. Same reference count as `acquire`, so an
    // extension cannot be cut off by the last spot panel closing, nor keep the
    // socket alive after it detaches.
    hold() {
        this.holds += 1;
        this._sync();
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.holds -= 1;
            this._sync();
        };
    }

    _wanted() {
        return this.holds > 0 || STREAMS.some((s) => this.wants(s));
    }

    // True when this socket is registered to a session that no longer exists.
    //
    // The UUID travels in the URL and is fixed for the life of the socket, but
    // starting the receiver mints a new one — so a socket that outlives a power
    // cycle is still identified as the old session. The server keys real
    // behaviour on that: chat presence, and which audio session an extension
    // attaches to, which is why an attach on a stale socket comes back "no
    // active audio session found" while everything looks connected.
    get stale() {
        return !!this.ws && this.openedWith !== getSessionId();
    }

    // Reopens a stale socket, and answers whether it did. Reopening restores
    // the subscriptions — the ref counts survive a disconnect and are replayed
    // on open — so this costs a round trip and nothing else.
    refresh() {
        if (!this.stale) return false;
        this.disconnect();
        this.connect();
        return true;
    }

    // Opens or closes to match demand. The last release closes the socket
    // rather than leaving an idle connection counted against the session.
    _sync() {
        if (!this._wanted()) {
            if (this.ws || this.reconnectTimer || this.opening) this.disconnect();
            return;
        }
        if (this.refresh()) return;
        this.connect();
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
        if (this.closedByUser || !this._wanted()) return false;

        const sessionId = getSessionId();
        const q = new URLSearchParams({ user_session_id: sessionId });
        const password = getBypassPassword();
        if (password) q.set('password', password);

        this.openedWith = sessionId;
        // A new socket knows nothing about us, whatever the last one was told.
        this.identitySent = false;
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
        // Decoder results arrive as binary frames. Asking for ArrayBuffers
        // rather than the default Blob keeps their handling synchronous, so a
        // result cannot be delivered after the extension has detached.
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
            // TEMPORARY — see send().
            console.log(`[chat-wire] socket OPEN session=${this.openedWith} wants(chat)=${this.wants('chat')}`);
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
            // Binary frames are decoder results, one per frame. Emitted rather
            // than parsed here: this socket does not know what any extension's
            // payload means — see extensions/protocol.js.
            if (typeof ev.data !== 'string') {
                this.emit('binary', ev.data);
                return;
            }
            let msg;
            try { msg = JSON.parse(ev.data); } catch (e) { return; }
            this._onMessage(msg);
        };
        ws.onerror = () => this.emit('error', { message: 'dxcluster socket error' });
        ws.onclose = (ev) => {
            // TEMPORARY — see send().
            console.log(`[chat-wire] socket CLOSE code=${ev && ev.code} session=${this.openedWith}`);
            this._onClose();
        };
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
        // TEMPORARY — chat double-join diagnosis. Remove once the cause is
        // known. Logs every chat message that reaches the wire, with the
        // session the socket carries and where the call came from.
        if (typeof msg.type === 'string' && msg.type.startsWith('chat_')) {
            const where = (new Error().stack || '').split('\n').slice(2, 5).join(' | ');
            console.log(`[chat-wire] ${msg.type} session=${this.openedWith} connected=${this.connected}`,
                msg.username || '', '\n           from:', where);
        }
        if (!this.connected) return false;
        this.ws.send(JSON.stringify(msg));
        return true;
    }

    // ---- chat -----------------------------------------------------------

    setUsername(username) {
        this.username = username;
        // Sent now, so the replay does not send it a second time when the next
        // subscription confirmation arrives on this same socket.
        this.identitySent = true;
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
        this.identitySent = false;
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

            // FreeDV Reporter: who the server can see on the air. A snapshot on
            // subscribe, then one update per change — see freedv_reporter_store.go.
            case 'freedv_activity_snapshot':
                this.emit('freedv', { kind: 'snapshot', users: msg.users || [] });
                break;
            case 'freedv_activity_update':
                this.emit('freedv', {
                    kind: 'update',
                    event: msg.event,
                    user: msg.user || null,
                    sid: msg.sid || null,
                });
                break;
            case 'chat_error':
                this.emit('error', { message: msg.error });
                break;
            case 'subscription_status': {
                const stream = msg.stream;
                // TEMPORARY — see send().
                if (stream === 'chat') {
                    console.log(`[chat-wire] <- subscription_status chat enabled=${!!msg.enabled}`
                        + ` session=${this.openedWith} username=${this.username} identitySent=${this.identitySent}`);
                }
                if (!(stream in this.confirmed)) break;
                this.confirmed[stream] = !!msg.enabled;
                if (stream === 'chat' && msg.enabled) {
                    // Safe to talk now. A reconnect must restore identity and
                    // status, or the user silently reverts to anonymous.
                    //
                    // Once per socket, though, not once per confirmation. Two
                    // confirmations on one socket are ordinary — acquire()
                    // subscribes when the ref count goes up on an already-open
                    // socket, and onopen subscribes everything wanted — and the
                    // server treats every chat_set_username as a join, announces
                    // it to the channel and sends its welcome again. That is the
                    // double join: the first confirmation had nothing to replay,
                    // ChatContext's own auto-join set the name, and the second
                    // confirmation replayed it straight back.
                    if (this.username && !this.identitySent) {
                        this.identitySent = true;
                        this.send({ type: 'chat_set_username', username: this.username });
                    }
                    if (this.lastStatus) this.send({ type: 'chat_set_frequency_mode', ...this.lastStatus });
                    this.send({ type: 'chat_request_users' });
                }
                // `error` distinguishes a refusal from the confirmation the
                // server also sends for an unsubscribe: both carry
                // enabled:false, and only one of them is news.
                this.emit('subscribed', { stream, enabled: !!msg.enabled, error: msg.error || '' });
                break;
            }
            default:
                // Audio-extension control replies, forwarded whole: the shapes
                // differ per message and only the extension client cares.
                if (typeof msg.type === 'string' && msg.type.startsWith('audio_extension_')) {
                    this.emit('extension', msg);
                }
                break;   // and pong
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
