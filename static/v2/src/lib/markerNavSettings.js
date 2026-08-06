// Which kinds of marker the on-screen prev/next controls step between.
//
// One selection, shared: the Markers panel's step buttons and the ends of the
// Multipad's frequency drum are two ways of doing the same thing, and somebody
// who has said "step between CW spots only" has said it about stepping, not
// about a panel. Two selections would mean the drum quietly disagreeing with the
// panel above it.
//
// Still not the one Media Session keeps, though — skipping between DX spots with
// the lock-screen buttons while stepping between bookmarks on screen is a
// reasonable thing to want, and the lock screen has no picker of its own to
// explain itself with.
//
// Shared means live: both pickers are on screen at once often enough (the pad
// floats over the dock on a touchscreen desktop), so a change has to reach the
// other one now rather than at its next mount. Hence the listeners — localStorage
// is where it persists, not how it propagates.

import { NAV_TYPES } from './markerNav.js';

const KEY = 'ubersdr.v2.markernav';

// The labels, in the order they are offered. Keyed by the type vocabulary in
// markerNav.js, so a type added there shows up here as soon as it is labelled.
export const NAV_LABELS = {
    dx: 'DX',
    cw: 'CW',
    voice: 'Voice',
    'bookmark-server': 'Bookmarks',
    'bookmark-local': 'Local',
};

export const DEFAULT_NAV_TYPES = NAV_TYPES;

const clean = (list) => (Array.isArray(list) ? list.filter((t) => NAV_TYPES.includes(t)) : []);

const listeners = new Set();

export function savedNavTypes() {
    try {
        const saved = clean(JSON.parse(localStorage.getItem(KEY)));
        return saved.length ? saved : DEFAULT_NAV_TYPES;
    } catch (e) {
        return DEFAULT_NAV_TYPES;
    }
}

// The only writer, so nothing can change the selection without the other picker
// hearing about it.
//
// Not `setNavTypes`: Media Session's context already has an action by that name
// for its own selection, and two different setters spelled the same way is a
// mistake waiting to be made in the file that has both. (test/unresolved.js
// refuses the collision outright.)
export function saveNavTypes(list) {
    const next = clean(list);
    // Never all-off: with nothing selected there is nothing to step to, and both
    // controls would go permanently dead with nothing on screen to say why.
    if (!next.length) return;
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (e) { /* private mode */ }
    // The same array to every listener, so the two pickers hold one identity and
    // a useMemo keyed on it does not re-run once per subscriber.
    for (const fn of [...listeners]) {
        try { fn(next); } catch (e) { /* a broken listener is not the setting's problem */ }
    }
}

export function onNavTypes(fn) {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}
