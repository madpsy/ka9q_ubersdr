// Which kinds of marker the Markers panel steps between.
//
// Its own setting rather than the one Media Session keeps: skipping between DX
// spots with the lock-screen buttons and between bookmarks on screen are both
// reasonable things to want, and neither should decide the other.

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

export function savedNavTypes() {
    try {
        const saved = clean(JSON.parse(localStorage.getItem(KEY)));
        return saved.length ? saved : DEFAULT_NAV_TYPES;
    } catch (e) {
        return DEFAULT_NAV_TYPES;
    }
}

export function saveNavTypes(list) {
    const next = clean(list);
    if (!next.length) return;
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (e) { /* private mode */ }
}
