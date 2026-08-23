// Where a custom panel keeps its own data.
//
// A panel runs in `<iframe sandbox="allow-scripts">`, which is an opaque origin:
// `localStorage`, `sessionStorage` and IndexedDB all *throw* on access inside
// it — not "return empty", throw — and cookies are blocked. The srcdoc is
// rebuilt on every mount, so even in-memory state dies when a panel is collapsed
// and reopened. Without something on this side, a clocks panel cannot remember
// which cities you picked.
//
// IndexedDB rather than localStorage, and the reason is isolation rather than
// size. localStorage is one ~5 MB pot shared with the layout, the display
// preferences and the bridge settings; a panel that wrote too much would not
// break itself, it would make v2's own next write throw, and the symptom would
// be a layout that quietly stopped saving. A separate store spends a separate
// budget. Structured clone is a bonus: a panel can keep an ArrayBuffer or an
// ImageBitmap directly rather than base64 in the pot the layout lives in.
//
// Per origin, which here means per *receiver*, everywhere.
//
// That is worth stating because the desktop client looks as though it would
// break it: every receiver window is a loopback address. But each receiver gets
// its own persisted local port — "the stored port is the instance's origin (and
// so its localStorage)", clients/electron/main.js — so the origins differ and so
// does this store. The mobile client keeps a `localPort` per receiver for the
// same reason.
//
// The desktop client's shared settings copy a subset of `ubersdr.v2.*`
// *localStorage* keys between those origins, which is how a preference follows
// an operator from one receiver to the next. IndexedDB is not localStorage and
// is never copied, so a panel's data stays with the receiver it was entered on —
// which is the right answer for a panel whose settings are about that receiver's
// bands, antennas or frequencies.

const DB_NAME = 'ubersdr.v2.panels';
const DB_VERSION = 1;
const STORE = 'data';

// What one panel may keep. Generous — a cached image is a legitimate thing to
// store — but not absent: origin storage is best-effort and eviction is
// origin-wide, so a panel that filled the bucket could take everything else on
// this origin with it.
export const MAX_PANEL_BYTES = 2 * 1024 * 1024;
// And a bound on any single key, so one runaway write cannot consume the lot.
export const MAX_VALUE_BYTES = 512 * 1024;

let dbPromise = null;

function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        let req;
        try {
            req = indexedDB.open(DB_NAME, DB_VERSION);
        } catch (e) {
            // Private mode, blocked site data, or no IndexedDB at all.
            reject(e);
            return;
        }
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('indexeddb open failed'));
        req.onblocked = () => reject(new Error('indexeddb blocked'));
    }).catch((e) => {
        // Let a later attempt try again rather than caching the failure for the
        // life of the page — site data can be unblocked while the page is open.
        dbPromise = null;
        throw e;
    });
    return dbPromise;
}

function tx(mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        let out;
        try {
            out = fn(store);
        } catch (e) {
            reject(e);
            return;
        }
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error || new Error('indexeddb transaction failed'));
        t.onabort = () => reject(t.error || new Error('indexeddb transaction aborted'));
    }));
}

// Keys are namespaced by panel, so one panel cannot read or overwrite another's
// data even by guessing. The upper bound is the highest code point, so the range
// covers every key this panel could have written and no other panel's.
const SEP = ' ';
const keyFor = (panelId, key) => panelId + SEP + key;
const rangeFor = (panelId) => IDBKeyRange.bound(panelId + SEP, panelId + SEP + '￿');

/** Rough size of a value, for the quota. Cheap rather than exact. */
function sizeOf(value) {
    if (value == null) return 0;
    if (typeof value === 'string') return value.length * 2;
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (ArrayBuffer.isView(value)) return value.byteLength;
    try {
        return JSON.stringify(value).length * 2;
    } catch (e) {
        // Cyclic, or something JSON cannot see. Structured clone may still take
        // it, so charge it the per-value cap rather than refusing outright.
        return MAX_VALUE_BYTES;
    }
}

/**
 * Everything one panel has stored, as a plain object.
 *
 * Read once when a panel starts and handed over with the port, so the panel's
 * own code can be synchronous about its settings — asking a parent across a
 * message channel during first render is not a thing an author should have to
 * think about.
 */
export async function readAll(panelId) {
    try {
        const out = {};
        await tx('readonly', (store) => {
            const req = store.openCursor(rangeFor(panelId));
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) return;
                out[String(cursor.key).slice(panelId.length + SEP.length)] = cursor.value;
                cursor.continue();
            };
        });
        return out;
    } catch (e) {
        // Unavailable is not an error a panel should have to handle: it gets an
        // empty store and its writes go nowhere, which is the same experience as
        // a first run. See CUSTOM_PANELS.md §5.3.
        return {};
    }
}

/**
 * Write one key. `undefined` deletes it.
 *
 * Returns a string when the write was refused, which the panel is told, or null
 * on success. Silence would be worse: a panel that thinks it saved something and
 * did not will show the operator stale settings for ever.
 */
export async function writeKey(panelId, key, value) {
    if (typeof key !== 'string' || key === '') return 'a store key must be a non-empty string';

    if (value === undefined) {
        try {
            await tx('readwrite', (store) => store.delete(keyFor(panelId, key)));
            return null;
        } catch (e) {
            return 'storage is unavailable';
        }
    }

    const size = sizeOf(value);
    if (size > MAX_VALUE_BYTES) {
        return 'that value is ' + Math.round(size / 1024) + ' kB and the limit for one key is '
            + (MAX_VALUE_BYTES / 1024) + ' kB';
    }

    try {
        const existing = await readAll(panelId);
        let total = 0;
        for (const [k, v] of Object.entries(existing)) {
            if (k !== key) total += sizeOf(v);
        }
        if (total + size > MAX_PANEL_BYTES) {
            return "this panel's storage is full (" + (MAX_PANEL_BYTES / 1024 / 1024) + ' MB)';
        }
        await tx('readwrite', (store) => store.put(value, keyFor(panelId, key)));
        return null;
    } catch (e) {
        return 'storage is unavailable';
    }
}

/**
 * Forget everything one panel stored.
 *
 * Deliberately *not* wired to a panel being removed, which is the obvious place
 * and the wrong one. Removal is frequently temporary — an operator swapping
 * panels around, a collector hiccup — and the layout already takes the other
 * view: a removed panel keeps its dock position and its hidden flag so that
 * enabling it again puts it back exactly as it was left. Data that vanished
 * while placement survived would be the worst of both.
 *
 * So this is for a caller who means it, and there is not one yet. The per-panel
 * cap is what bounds what an unused panel can leave behind.
 */
export async function clearPanel(panelId) {
    try {
        await tx('readwrite', (store) => store.delete(rangeFor(panelId)));
        return true;
    } catch (e) {
        return false;
    }
}
