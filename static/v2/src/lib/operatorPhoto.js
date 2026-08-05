// Operator photos: the setting, the cache, and who is allowed a blob.
//
// One module because three things want the same picture — the Callsign panel,
// the lock-screen card, and anything else that grows a use for it — and each
// arriving at its own answer is how the setting came to be honoured in one
// place and not the other, and how the same image came to be fetched three
// times for one lookup.
//
// The two accessors are deliberately different, and the difference is a safety
// rule rather than a convenience:
//
//   photoUrl()      the same-origin proxy path. What anything rendering an
//                   <img> should use: it paints progressively, the browser
//                   caches it, and there is nothing to revoke.
//
//   photoBlobUrl()  a blob: URL, cached here. Only the lock screen needs this
//                   — Chrome re-fetches an artwork URL on every waiting→playing
//                   transition, hundreds of times during buffering, and an
//                   absolute URL to a receiver on a self-signed local cert
//                   silently fails on a phone. Blobs are revoked when the cache
//                   is trimmed, so an <img> holding one would turn into a
//                   broken icon at a moment decided by an unrelated consumer.
//                   Nothing that renders should touch it.

const KEY = 'ubersdr.v2.callsignPhoto';

// --- the setting -------------------------------------------------------------

const listeners = new Set();

export function photoShown() {
    try {
        return localStorage.getItem(KEY) !== 'off';
    } catch (e) {
        return true;
    }
}

export function setPhotoShown(on) {
    try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch (e) { /* private mode */ }
    for (const fn of Array.from(listeners)) fn(!!on);
    return !!on;
}

export function onPhotoShown(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

// --- what to render ----------------------------------------------------------

/** The path to put in an `<img>`, or '' when photos are switched off. */
export function photoUrl(path) {
    return photoShown() && path ? String(path) : '';
}

// --- the blob cache ----------------------------------------------------------

// Proxy path -> blob URL, and the fetches in flight, so two consumers asking at
// the same moment share one request.
const blobs = new Map();
const pending = new Map();

// Photos accumulate one blob per operator over a long session.
const MAX_PHOTOS = 12;

async function toBlobUrl(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return URL.createObjectURL(await resp.blob());
}

/**
 * A blob: URL for a photo, or the plain path if it could not be fetched.
 *
 * Resolves to '' when photos are switched off, so a caller cannot fetch one by
 * forgetting to ask.
 */
export function photoBlobUrl(path) {
    if (!path || !photoShown()) return Promise.resolve('');
    if (blobs.has(path)) return Promise.resolve(blobs.get(path));
    if (pending.has(path)) return pending.get(path);

    const p = toBlobUrl(path)
        .then((url) => {
            blobs.set(path, url);
            pending.delete(path);
            return url;
        })
        .catch((err) => {
            console.warn('[photo]', err.message);
            // Remembered as the raw path rather than retried on every tuning
            // change; the proxy URL may still work directly.
            blobs.set(path, path);
            pending.delete(path);
            return path;
        });

    pending.set(path, p);
    return p;
}

/**
 * Drop blobs beyond the cap, keeping the one in use.
 *
 * Called by whoever is displaying a photo when it moves on to another. Only
 * blob: URLs are revoked — a raw path is a failure marker, not an allocation.
 */
export function trimPhotos(keep) {
    if (blobs.size <= MAX_PHOTOS) return;
    for (const [path, url] of blobs) {
        if (blobs.size <= MAX_PHOTOS) break;
        if (path === keep) continue;
        if (url.startsWith('blob:')) URL.revokeObjectURL(url);
        blobs.delete(path);
    }
}

/** Test seam. */
export function _resetPhotos() {
    for (const url of blobs.values()) {
        if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    }
    blobs.clear();
    pending.clear();
}
