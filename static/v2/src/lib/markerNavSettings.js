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

// Nothing selected is a selection, and the one thing this has to get right is
// telling it apart from nothing *stored*. An empty array is "stepping off" — the
// drum's ends go away and the panel's buttons say why. No key at all is a browser
// that has never been told, which is every kind.
//
// A stored selection that this build recognises none of is neither: it was a real
// choice, made against a vocabulary that has since changed, and honouring it as
// "off" would silently turn kinds nobody switched off into a control that has
// vanished. That falls back to everything, as it always did.
export function savedNavTypes() {
    try {
        const raw = localStorage.getItem(KEY);
        if (raw == null) return DEFAULT_NAV_TYPES;
        const saved = JSON.parse(raw);
        if (!Array.isArray(saved)) return DEFAULT_NAV_TYPES;
        if (!saved.length) return [];
        const kept = clean(saved);
        return kept.length ? kept : DEFAULT_NAV_TYPES;
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
    if (!Array.isArray(list)) return;
    const next = clean(list);
    // All off is allowed and means it: the controls take themselves away rather
    // than going dead, so there is nothing to protect the operator from here.
    // What is refused is a request made *entirely* of kinds this build does not
    // have — that is a caller bug, and storing it as "off" would turn a typo into
    // a setting.
    if (list.length && !next.length) return;
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
