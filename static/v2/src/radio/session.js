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

// One UUID per session, and one spare nobody asked for — which is the part
// worth explaining.
//
// A UUID is fixed for the life of a session, including across automatic
// reconnects, because the server keys real behaviour on it: it links the audio
// and spectrum sessions into one user, detects a reconnect and *replaces* the
// old session rather than stacking a second one (the "reconnection detected"
// path in session.go), and rate-limits session creation per UUID to damp
// reconnect loops. Minting a new one mid-session would defeat all three.
//
// Starting the receiver again after stopping it is a new session and gets a new
// id. The awkward case is the *first* start of a visit, because by then an id
// has already been registered: the Start overlay asks /connection on load to
// find out whether the receiver is full, and asking registers the id it asks
// about. So minting at that first press left the overlay's id paid for and
// never used — two POSTs per page load, one of them for nothing, out of the ten
// a minute the endpoint allows per IP.
//
// Hence the rule below: the first start adopts the id the overlay registered,
// and every start after that mints. One registration per session either way,
// and none wasted.
//
// Generated lazily, never at module load: importing a connection module must
// not touch `window`, or the module cannot be loaded outside a browser.
let currentId = null;

// Whether `currentId` has already been used to start a session. The overlay's
// preflight leaves an id that has not, and that is the one the first start
// adopts rather than replaces.
let started = false;

export function getSessionId() {
    if (!currentId) currentId = uuid();
    return currentId;
}

// Mints a new id unconditionally, discarding whatever the old one had.
//
// Only startSessionId() and the tests should need this: everything else wants
// the id for the session in progress, and replacing it is a decision rather
// than a step.
export function newSessionId() {
    currentId = uuid();
    started = false;
    registration = null;
    serverSessionId = null;
    return currentId;
}

/** Whether the current id has already run a session. Exposed for tests. */
export function sessionStarted() {
    return started;
}

// The id to start a session under.
//
// Called by powerOn, and the one place that decides whether a start continues
// the identity that already exists or replaces it. Both sockets then use
// whatever this returns — the server pairs audio and spectrum by UUID.
//
// A new id for every start except the first, which adopts the one the Start
// overlay's capacity check already registered. That also means a session the
// server has finished with — an idle timeout blacklists the UUID for an hour —
// is escaped by construction: pressing Listen again cannot hand back the id
// that was refused.
export function startSessionId() {
    if (!currentId || started) newSessionId();
    started = true;
    return currentId;
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
// Cached for the life of the id, and deliberately not on a timer. What used to
// be here was a two-minute TTL, which made a reconnect re-register or not
// depending on nothing but how long the outage had been running — the same
// press of the spectrum's pause button made a request or did not, while the
// hidden-tab pause five seconds later never did. It also put an HTTP round trip
// in front of every retry, on the one path that runs when the network is
// already unwell.
//
// So: one POST per id, and a retry costs nothing. Which is also what the
// server's accounting expects. `max_session_time` runs from the first time the
// server saw the UUID (`userSessionFirst`, written once with an `if !exists`
// guard) and a retry keeps the same id, so re-registering cannot move that
// clock — but a POST per attempt would still spend the rate-limit budget three
// sockets share, and a 429 in the middle of an outage turns a connection that
// was coming back into one that is not.
//
// The exception is a re-registration, and it is the one case a client can
// actually fix. The server forgets a registration five minutes after the id's
// last session ends, and a restart forgets it at once; every endpoint then
// answers "Invalid session", and without asking again there is no way back.
// So the sockets may ask again — under the *same* id, so the server's clock for
// this session is untouched — but only on evidence (see `needsRegistration` in
// the connections), and no more often than this floor. That makes it a response
// to one specific refusal rather than a step in the retry loop.
const REREGISTER_MIN_MS = 15000;
let registration = null;

/**
 * @param {{reregister?: boolean}} [opts]  `reregister` asks for a fresh POST
 *        under the current id, for a caller that has reason to believe the
 *        server has forgotten it. Subject to the floor above; everything else
 *        shares the one answer.
 */
export function connectionCheck({ reregister = false } = {}) {
    const id = getSessionId();
    const now = Date.now();
    if (registration && registration.id === id) {
        if (!reregister) return registration.promise;
        // One at a time, and not on every attempt: three sockets discovering
        // the same lapse in the same second must not make three POSTs of it.
        if (registration.pending || now - registration.at < REREGISTER_MIN_MS) {
            return registration.promise;
        }
    }
    const promise = checkConnection();
    const entry = { id, at: now, pending: true, promise };
    registration = entry;
    // Neither a refusal nor an unanswered request may be cached: the next
    // attempt has to ask again rather than replay the no. `status === 0` is
    // checkConnection's own mark for a fetch that did not complete, which it
    // reports as *allowed* so a flaky check never blocks an otherwise-working
    // connection — cached, that would be a permanent yes nothing could clear.
    const settle = (keep) => {
        entry.pending = false;
        if (!keep && registration === entry) registration = null;
    };
    promise.then(
        (r) => settle(!!(r && r.allowed && r.status !== 0)),
        () => settle(false),
    );
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
// ten a minute this endpoint allows per IP. connectionCheck() is the way in; it
// re-asks whenever the id or the password changes, and on request for a socket
// the server has stopped recognising, which covers every reason anybody reached
// for this directly.
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
            // Whether the server is treating this client as bypassed — an IP in
            // timeout_bypass_ips, or the password above being the right one.
            // Only the server can answer it: an accepted password and a listed
            // IP look identical from here, and the second leaves nothing in the
            // browser to look at.
            bypassed: !!data.bypassed,
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
            // Not bypassed, deliberately, where `allowed` above is true: an
            // unanswered check must not hand out a privilege. The cost of
            // being wrong is a listener seeing a range marked as blocked that
            // they can in fact hear, which is the harmless direction.
            bypassed: false,
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
