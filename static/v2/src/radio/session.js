// User session identity.
//
// The server binds a UUID to the client IP and User-Agent when POST /connection
// is called, and both WebSocket endpoints reject UUIDs it has not seen. So the
// handshake has to happen once, before either socket is opened.

function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    // Fallback for non-secure contexts, where randomUUID is unavailable.
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// One UUID per page load, not per start, and not persisted — v1's rule.
//
// It stays fixed across power cycles as well as across automatic reconnects,
// because the server keys real behaviour on it: it links the audio and spectrum
// sessions into one user, detects a reconnect and *replaces* the old session
// rather than stacking a second one (see the "reconnection detected" path in
// session.go), and rate-limits session creation per UUID specifically to damp
// reconnect loops. Minting a new one mid-session would defeat all three.
//
// Minting one per *start* defeated something quieter. Registering a UUID is a
// POST to /connection, and the Start overlay has already made one to find out
// whether there is room — so a fresh id at the press meant every page load
// registered two, used one, and left the other to be swept up five minutes
// later. It also cost two of the ten requests a minute that endpoint allows per
// IP, which on a page somebody is reloading is the difference between working
// and being told to wait.
//
// Generated lazily, never at module load: importing a connection module must
// not touch `window`, or the module cannot be loaded outside a browser.
let currentId = null;

// Whether the server has finished with `currentId` — see markSessionSpent.
let spent = false;

export function getSessionId() {
    if (!currentId) currentId = uuid();
    return currentId;
}

// Mints a new id unconditionally, discarding whatever the old one had.
//
// Only startSessionId() and the tests should need this: everything else wants
// the id for this visit, and replacing it is a decision rather than a step.
export function newSessionId() {
    currentId = uuid();
    spent = false;
    registration = null;
    serverSessionId = null;
    return currentId;
}

// Records that the current id can no longer be used, so the next start replaces
// it instead of reusing it.
//
// There is exactly one thing that does this, and it is not recoverable any
// other way: the server reclaims an idle session by blacklisting its UUID for
// an hour, and it forgets a UUID's registration five minutes after the last
// session under it ends. Either way every endpoint answers that id with the
// same refusal for as long as it takes, so reusing it would hand the operator a
// receiver that cannot start — the thing that used to need a page reload.
//
// Deliberately not called for a ban or a bad password: those follow the client,
// not the id, and a new one would only be a second refusal.
export function markSessionSpent() {
    spent = true;
}

/** Whether the next start will have to mint a new id. Exposed for tests. */
export function sessionSpent() {
    return spent;
}

// The id to start a session under: the visit's own, unless it is spent.
//
// Called by powerOn, and the one place that decides whether a start is a new
// identity or a continuation of this one. Both sockets then use whatever this
// returns — the server pairs audio and spectrum by UUID.
export function startSessionId() {
    if (currentId && !spent) return currentId;
    return newSessionId();
}

// The *server's* id for this audio session, which is a different thing from the
// UUID above and not interchangeable with it.
//
// getSessionId() is ours: minted in the browser, sent as `user_session_id`, and
// used to pair the audio and spectrum sockets. This one is the server's own
// session key, handed back in the `status` message — and it is what /stats
// matches on (`session.ID`) to hoist your row to the front of the listener
// list. Sending the UUID there instead matches nothing, so nobody is hoisted
// and the first row is simply another listener.
//
// Cleared when the socket closes: an id from a session that has ended would
// still be sent, still match nothing, and still leave whoever happens to be
// first looking like you.
let serverSessionId = null;

export function setServerSessionId(id) {
    serverSessionId = id || null;
}

export function getServerSessionId() {
    return serverSessionId;
}

// `/connection` registers the UUID against this IP and User-Agent, which both
// WebSocket endpoints require before they will accept it. Two sockets open per
// session, so the result is shared rather than each of them POSTing: the
// endpoint is rate-limited to 10 requests per minute per IP, and burning two
// per session start (plus two more per reconnect) would eat that budget for no
// benefit.
//
// The registration is cached only briefly. Server-side it survives while any
// session is live and for five minutes after the last one ends, so a long
// reconnect outage needs a fresh POST — this TTL is comfortably inside that
// window while still collapsing the normal burst to one request.
const REGISTRATION_TTL_MS = 120000;
let registration = null;

export function connectionCheck() {
    const id = getSessionId();
    const now = Date.now();
    if (registration && registration.id === id && now - registration.at < REGISTRATION_TTL_MS) {
        return registration.promise;
    }
    const promise = checkConnection();
    registration = { id, at: now, promise };
    // A refusal must not be cached — the next attempt should ask again.
    promise.then((r) => {
        if (!r || !r.allowed) registration = null;
    }, () => { registration = null; });
    return promise;
}

export function getBypassPassword() {
    const fromUrl = new URLSearchParams(location.search).get('password');
    if (fromUrl) {
        try { sessionStorage.setItem('ubersdr.v2.password', fromUrl); } catch (e) { /* ignore */ }
        return fromUrl;
    }
    try { return sessionStorage.getItem('ubersdr.v2.password') || ''; } catch (e) { return ''; }
}

// Typed into the start overlay rather than given in the URL. Session storage,
// not local: a bypass is for this tab and this sitting, and a password left in
// a browser for the next person is a password the operator did not share.
// An empty value clears it, which is what a refusal does.
export function setBypassPassword(password) {
    try {
        if (password) sessionStorage.setItem('ubersdr.v2.password', password);
        else sessionStorage.removeItem('ubersdr.v2.password');
    } catch (e) { /* private mode */ }
    // The registration is per password: one cached under a rejected one would
    // be replayed by the next connect.
    registration = null;
}

// Returns { allowed, reason, clientIp, sessionId }. A network failure is
// reported as allowed so a flaky check never blocks an otherwise-working
// connection.
//
// `sessionId` is the id this particular check registered, and it is in the
// reply because the sockets need it rather than because the caller asked. A
// socket opens after awaiting the check, and the id can move during that await
// — powerOn mints a new one — so reading getSessionId() again afterwards can
// hand the socket an id the server has never been told about. The id that came
// back with the answer is the one the answer is about.
// Not exported. Asking /connection also *registers* the id it asks about, so
// every caller that skips the cache buys a registration the next one pays for
// again — which is exactly how a page load came to cost two requests out of the
// ten a minute this endpoint allows per IP. connectionCheck() is the way in;
// it re-asks whenever the id or the password changes, which covers every reason
// anybody reached for this directly.
async function checkConnection() {
    const id = getSessionId();
    const body = { user_session_id: id };
    const password = getBypassPassword();
    if (password) body.password = password;

    try {
        const res = await fetch('/connection', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json();
        return {
            allowed: !!data.allowed,
            reason: data.reason || '',
            clientIp: data.client_ip || '',
            // Seconds this session may run, 0 meaning unlimited. Only the
            // /connection reply carries it — it depends on whether this client
            // is bypassed, so it is not in /api/description.
            maxSessionTime: typeof data.max_session_time === 'number' ? data.max_session_time : null,
            // Seconds of *inactivity* before the server reclaims the session,
            // 0 meaning it never does. The idle watch counts against this, and
            // it comes from the same reply for the same reason max_session_time
            // does: it depends on whether this client is bypassed.
            sessionTimeout: typeof data.session_timeout === 'number' ? data.session_timeout : null,
            status: res.status,
            sessionId: id,
        };
    } catch (err) {
        return {
            allowed: true,
            reason: 'connection check failed',
            clientIp: '',
            maxSessionTime: null,
            sessionTimeout: null,
            status: 0,
            sessionId: id,
        };
    }
}

export function wsBase() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}`;
}

// Bytes in one websocket frame, for the sockets' own byte counters.
//
// Text frames are measured in UTF-16 code units rather than encoded bytes:
// these carry ASCII JSON, where the two are the same, and encoding every
// control frame to count it would cost more than the number is worth.
export function frameSize(data) {
    if (data instanceof ArrayBuffer) return data.byteLength;
    if (data && typeof data.byteLength === 'number') return data.byteLength;   // TypedArray
    if (data && typeof data.size === 'number') return data.size;               // Blob
    return data ? String(data).length : 0;
}
