// User session identity.
//
// The server binds a UUID to the client IP and User-Agent when POST /connection
// is called, and both WebSocket endpoints reject UUIDs it has not seen. So the
// handshake has to happen once, before either socket is opened.

const STORAGE_KEY = 'ubersdr.v2.sessionId';

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

export function getSessionId() {
    let id = null;
    try {
        id = sessionStorage.getItem(STORAGE_KEY);
    } catch (e) { /* private mode */ }
    if (!id) {
        id = uuid();
        try { sessionStorage.setItem(STORAGE_KEY, id); } catch (e) { /* ignore */ }
    }
    return id;
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
            status: res.status,
        };
    } catch (err) {
        return { allowed: true, reason: 'connection check failed', clientIp: '', status: 0 };
    }
}

export function wsBase() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}`;
}
