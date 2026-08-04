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

// A fresh UUID is minted each time the user starts a session, and is not
// persisted — v1 does the same, generating one per page load.
//
// It stays fixed for the life of that session, including across automatic
// reconnects, because the server keys real behaviour on it: it links the audio
// and spectrum sessions into one user, detects a reconnect and replaces the old
// session instead of stacking a second one, and rate-limits session creation
// per UUID specifically to damp reconnect loops. Minting a new one mid-session
// would defeat all three.
// Generated lazily, never at module load: importing a connection module must
// not touch `window`, or the module cannot be loaded outside a browser.
let currentId = null;

export function getSessionId() {
    if (!currentId) currentId = uuid();
    return currentId;
}

// Called when starting a session. Both sockets must then use the same id — the
// server pairs audio and spectrum by UUID.
export function newSessionId() {
    currentId = uuid();
    registration = null;
    return currentId;
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

// Returns { allowed, reason, clientIp }. A network failure is reported as
// allowed so a flaky check never blocks an otherwise-working connection.
export async function checkConnection() {
    const body = { user_session_id: getSessionId() };
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
            status: res.status,
        };
    } catch (err) {
        return { allowed: true, reason: 'connection check failed', clientIp: '', maxSessionTime: null, status: 0 };
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
