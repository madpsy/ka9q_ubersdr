// Whether the page answers outside clients at all.
//
// On by default. The bridge reaches no further than this origin — a page on
// another site cannot see these events, and anything already running in *this*
// page could drive the receiver directly — so refusing by default would cost
// every extension user a settings hunt and buy nothing.
//
// The switch exists anyway, because "my browser extension can retune my
// receiver" is a thing an operator is entitled to say no to, and because a
// disabled bridge answers plainly (`disabled`) rather than going silent: a
// client can then say so instead of looking broken.
//
// Its own store, on the pattern of lib/announce.js: the host reads it on every
// message and lives for the whole session, while whatever edits it is a panel
// that may never be mounted. The key is under `ubersdr.v2.`, so the Backup
// panel picks it up with no line anywhere.

const STORAGE_KEY = 'ubersdr.v2.bridge';

export const DEFAULTS = { enabled: true };

let current = null;
const listeners = new Set();

function load() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
        return { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
    } catch (e) {
        return { ...DEFAULTS };
    }
}

export function bridgeSettings() {
    if (!current) current = load();
    return current;
}

export function setBridgeSettings(patch) {
    current = { ...bridgeSettings(), ...patch };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch (e) { /* private mode */ }
    for (const fn of Array.from(listeners)) fn(current);
    return current;
}

export function onBridgeSettings(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

// --- who is attached --------------------------------------------------------
//
// The count behind the badge above the spectrum. "Something outside this page
// is driving my receiver" is a thing an operator must be able to see at a
// glance — v1 had an on-page indicator for exactly this and it should not be
// lost. Kept here rather than in the host so a component can watch it without
// reaching into the serving machinery.

let attached = 0;
const attachedListeners = new Set();

export function bridgeAttached() {
    return attached;
}

export function setBridgeAttached(n) {
    if (n === attached) return attached;
    attached = n;
    for (const fn of Array.from(attachedListeners)) fn(n);
    return attached;
}

export function onBridgeAttached(fn) {
    attachedListeners.add(fn);
    return () => attachedListeners.delete(fn);
}
