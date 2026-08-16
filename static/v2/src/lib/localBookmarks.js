// Local (browser-side) bookmarks.
//
// The store itself is v1's, imported rather than reimplemented: the data lives
// in one IndexedDB database shared by both frontends, so anything saved in v1
// shows up in v2 and vice versa, and a second implementation could only drift.
// That means the same database (`ubersdr_bookmarks`, store `bookmarks`, keyed
// on name), the same record shape, and the same one-time migration out of the
// legacy `ubersdr_local_bookmarks` localStorage key.
//
// Only the UI is v2's. This module adds what a React panel needs on top: a
// single shared manager instance and a subscription so every view re-renders
// after a write.

import LocalBookmarkManager from '../../../local-bookmarks.js';
import { saveText } from './saveFile.js';

let manager = null;
const listeners = new Set();

// Created on first use, not at import: opening IndexedDB from module scope
// would run for every session whether or not the panel is ever shown.
export function localBookmarks() {
    if (!manager) manager = new LocalBookmarkManager();
    return manager;
}

export function onLocalBookmarksChanged(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function announce() {
    for (const fn of listeners) {
        try { fn(); } catch (e) { /* a broken listener must not stop the others */ }
    }
}

// Every mutation goes through here so the panel never has to remember to
// refresh, and a change made in one dock is picked up by a floating copy.
export async function mutate(fn) {
    const m = localBookmarks();
    await m.ready;
    const result = await fn(m);
    announce();
    return result;
}

// ---------------------------------------------------------------------------
// Import / export plumbing
// ---------------------------------------------------------------------------

/**
 * The passband a bookmark's form is asking to store, from the two text fields.
 *
 * Here rather than in the panel because the rules are the awkward part, and all three of them
 * are about what the rest of the code does with the pair:
 *
 *   Both edges or neither. Tuning only restores a passband when both are numbers — one edge
 *   is not a filter — so a half-written pair would be stored for ever and never used.
 *
 *   Blank is null, not absent. The store leaves a field alone when it is `undefined`, which
 *   is what preserved an invisible passband through every edit; null is how you clear one.
 *
 *   Low below high, because that is the only order the receiver accepts, and the two fields
 *   are easy to fill in the wrong boxes.
 *
 * Returns `{ low, high }` on success, or `{ error }` with something to show the operator.
 */
export function passbandFields(lowText, highText) {
    const edge = (v) => {
        const t = String(v == null ? '' : v).trim();
        if (!t) return null;
        const n = parseInt(t, 10);
        return Number.isFinite(n) ? n : NaN;
    };
    const low = edge(lowText);
    const high = edge(highText);
    if (Number.isNaN(low) || Number.isNaN(high)) {
        return { error: 'The passband edges must be numbers, in Hz.' };
    }
    if ((low == null) !== (high == null)) {
        return { error: 'Give both passband edges, or neither.' };
    }
    if (low != null && low >= high) {
        return { error: 'The passband low edge must be below the high one.' };
    }
    return { low, high };
}

export const EXPORT_FORMATS = [
    { id: 'json', label: 'JSON', ext: 'json', type: 'application/json' },
    { id: 'yaml', label: 'YAML', ext: 'yaml', type: 'text/yaml' },
    { id: 'csv', label: 'CSV', ext: 'csv', type: 'text/csv' },
    { id: 'kiwisdr', label: 'KiwiSDR', ext: 'json', type: 'application/json' },
];

export function exportText(m, format) {
    switch (format) {
        case 'yaml': return m.exportYAML();
        case 'csv': return m.exportCSV();
        case 'kiwisdr': return m.exportKiwiSDR();
        default: return m.exportJSON();
    }
}

export function downloadFile(text, filename, type) {
    return saveText(text, filename, type);
}

// v1's file input accepts .json/.yaml/.yml/.csv and picks a parser from the
// content: a `dx` array is KiwiSDR, other JSON is a bookmark list. Anything
// else falls back to the extension.
export async function importText(m, filename, text, mode = 'merge') {
    const name = (filename || '').toLowerCase();
    const trimmed = text.trimStart();

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (e) { /* fall through to text formats */ }
        if (parsed) {
            if (parsed.dx && Array.isArray(parsed.dx)) return m.importKiwiSDR(text, mode);
            return m.importJSON(text, mode);
        }
    }
    if (name.endsWith('.csv')) return m.importCSV(text, mode);
    if (name.endsWith('.yaml') || name.endsWith('.yml')) return m.importYAML(text, mode);
    return m.importJSON(text, mode);
}
