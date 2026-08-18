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

// How long a socket has to stay open before the reconnect budget is refilled.
// Long enough that a connection the server upgrades and then refuses does not
// count as a success, short enough that a real one is never penalised — see the
// onopen handler.
const SETTLED_MS = 5000;

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

// Drops a socket without letting its close event reach us.
//
// Closing is not instant: the event arrives when the server gets round to the
// handshake, and on a fast link — a listener on the same subnet as the receiver
// — that is comfortably *after* a replacement socket has been installed. With
// the handlers still attached, that late event runs _onClose against state the
// new socket now owns: it nulls `this.ws`, stops the ping timer and, because
// connect() has already cleared closedByUser, books a reconnect. The result is
// a panel reading "Reconnecting…" over a socket that is receiving perfectly
// well, a send() that refuses to write to it, and a second later a third socket
// while the second is left open and orphaned on the server.
//
// So a socket being replaced or deliberately closed is abandoned instead: its
// handlers come off first, it can no longer report anything, and there is
// exactly one socket answering for this connection at every instant. Whatever
// the caller wants to tell the outside world about the closure, it says itself.
function abandon(ws) {
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try { ws.close(1000, 'client'); } catch (e) { /* ignore */ }
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
        // Refills `attempts` once a socket has proved itself — see onopen.
        this.settleTimer = null;
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
    //
    // Much rarer than it was. This socket used to open before the receiver had
    // started — the marker bar subscribed to spots on page load — which made
    // every visit begin with a socket on a session id that Start then replaced.
    // Now nothing subscribes until there is a receiver running, and connect()
    // opens under the id `/connection` registered rather than re-reading a
    // global afterwards, so what is left here is the genuine case: a power
    // cycle underneath a socket somebody is still holding.
    get stale() {
        return !!this.ws && this.openedWith !== getSessionId();
    }

    // Reopens a stale socket, and answers whether it did. Reopening restores
    // the subscriptions — the ref counts survive a replacement and are replayed
    // on open — so this costs a round trip and nothing else.
    refresh() {
        if (!this.stale) return false;
        this._replace();
        return true;
    }

    // Moves the connection onto the current session id.
    //
    // Deliberately not disconnect() followed by connect(). Those two share
    // `this.ws`, `closedByUser`, the ping timer and the subscription flags, and
    // sequencing them by hand means the old socket is still closing while the
    // new one is being opened — see abandon() for what the late close event
    // then does to the socket that replaced it. Between them there is also a
    // moment of state 'idle' and possibly 'reconnecting', which the Spots panel
    // draws, so a routine change of session id flashed "Reconnecting…" at the
    // operator for no reason.
    //
    // One step instead: the old socket is abandoned, its close is reported
    // once, and the new one opens. Nothing here ever sets closedByUser — this
    // is a continuation of the same connection, not somebody leaving — so a
    // failure to reopen still reaches the normal backoff.
    _replace() {
        const had = !!this.ws;
        abandon(this.ws);
        this.ws = null;
        clearInterval(this.pingTimer);
        this.pingTimer = null;
        clearTimeout(this.settleTimer);
        this.settleTimer = null;
        // A new socket knows nothing about us; the ref counts are what survives.
        for (const stream of STREAMS) this.confirmed[stream] = false;
        this.identitySent = false;
        // Said once, and only when there was something to close. Consumers that
        // hold an attachment on this socket — the audio extensions — have to
        // know it went, or they wait for results from a decoder the server tore
        // down with the session behind it.
        if (had) this.emit('close');
        this.connect();
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

        // The id `/connection` just registered, rather than whatever
        // getSessionId() says by now. The two differ when the receiver was
        // started or restarted during the await — powerOn mints a fresh id —
        // and both readings are wrong to open with: the old one is the id the
        // server has just been told to replace, and the new one is an id it has
        // never been told about at all, which the endpoints refuse with
        // "Invalid session. Please refresh the page and try again."
        //
        // That is the whole reason this socket ever went stale. Rather than
        // opening under one and patching it up afterwards, a move restarts the
        // dance under the id that won: connect() is re-entered, and the check
        // it makes registers the new id before the socket carries it.
        const sessionId = check.sessionId;
        if (sessionId !== getSessionId()) return this.connect();

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
            // Not `attempts = 0` here. The server accepts the upgrade and only
            // then decides it will not have us — a session it has already
            // reclaimed, a creation rate limit — so a refused connection still
            // fires onopen and is closed a moment later. Clearing the count on
            // the open event therefore reset the backoff on precisely the
            // failure the backoff exists for, and the socket retried once a
            // second for as long as the page was left up: the "Reconnecting…"
            // that appears, clears, and appears again.
            //
            // The budget is earned by staying up instead. Anything that lasts
            // this long is a working connection whatever it does afterwards,
            // and anything refused is closed inside a round trip.
            clearTimeout(this.settleTimer);
            this.settleTimer = setTimeout(() => { this.attempts = 0; }, SETTLED_MS);
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
        ws.onclose = (ev) => this._onClose(ev);
        return true;
    }

    disconnect() {
        this.closedByUser = true;
        this.opening = false;
        clearTimeout(this.reconnectTimer);
        clearInterval(this.pingTimer);
        clearTimeout(this.settleTimer);
        this.reconnectTimer = null;
        this.pingTimer = null;
        this.settleTimer = null;
        if (this.connected && this.username) this.send({ type: 'chat_leave' });
        const had = !!this.ws;
        // Abandoned rather than closed through _onClose, which would otherwise
        // fire against whatever this connection is doing by then — see
        // abandon(). 'close' is therefore emitted here, and now rather than a
        // round trip later, which is also the order consumers want: the socket
        // is gone the moment the last holder let go of it.
        abandon(this.ws);
        this.ws = null;
        for (const stream of STREAMS) this.confirmed[stream] = false;
        this.identitySent = false;
        if (had) this.emit('close');
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
        // Not before the server has said it is listening.
        //
        // Every chat message is refused until `subscribe_chat` has been
        // registered — "you must subscribe to chat first" — and the socket is
        // subscribed on open, so there is a round trip during which a join is
        // simply thrown away. Someone who opened the panel and typed a name
        // straight into it landed in exactly that window.
        //
        // What made it stick was the latch below. Setting `identitySent` here
        // said "the name is on its way", and the confirmation handler skips the
        // replay when it is set — so the one thing that would have recovered the
        // join was disabled by the join that failed. Pressing Join again did the
        // same thing again, which is why it kept saying the same thing.
        //
        // Held instead: `username` is remembered, `identitySent` stays false,
        // and the subscription confirmation sends it. That path already exists —
        // it is what restores identity across a reconnect.
        if (!this.confirmed.chat) {
            this.identitySent = false;
            return false;
        }
        // Sent now, so the replay does not send it a second time when the next
        // subscription confirmation arrives on this same socket.
        this.identitySent = true;
        return this.send({ type: 'chat_set_username', username });
    }

    sendMessage(message) {
        return this.send({ type: 'chat_message', message });
    }

    // Publishes what this receiver is listening to, so other users see it
    // beside our name — and can follow it. See lib/chatFollow.js.
    //
    // `zoom_bw` is the spectrum's resolution in Hz per bin, and it is only sent when there is
    // one: v1 omits the field rather than sending a zero, and a follower reads "no zoom
    // published" from its absence. It is what lets somebody following us match our view, so
    // leaving it out made following a v2 user strictly worse than following a v1 one.
    setStatus({ frequency, mode, bandwidthLow, bandwidthHigh, binBandwidth }) {
        const zoom = Number(binBandwidth);
        this.lastStatus = {
            frequency: Math.round(frequency),
            mode,
            bw_low: Math.round(bandwidthLow),
            bw_high: Math.round(bandwidthHigh),
            ...(zoom > 0 ? { zoom_bw: zoom } : {}),
        };
        // Held until the subscription is confirmed, as the name above is, and
        // for the same reason — the confirmation replays `lastStatus`, so a
        // status published a moment too early is not lost, only deferred.
        if (!this.confirmed.chat) return false;
        return this.send({ type: 'chat_set_frequency_mode', ...this.lastStatus });
    }

    requestUsers() {
        if (!this.confirmed.chat) return false;
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

    // Only ever the live socket dropping on its own. A socket this connection
    // gave up on — disconnect(), or a replacement — is abandoned with its
    // handlers detached and reports its own closure, so nothing that arrives
    // here belongs to a socket that has already been superseded.
    _onClose(ev) {
        clearInterval(this.pingTimer);
        clearTimeout(this.settleTimer);
        this.pingTimer = null;
        this.settleTimer = null;
        this.ws = null;
        for (const stream of STREAMS) this.confirmed[stream] = false;
        this.identitySent = false;
        this.emit('close', { code: ev && ev.code });
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
