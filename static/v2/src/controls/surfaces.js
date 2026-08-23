// Control surfaces that something outside the page provides.
//
// SDR Control drives this receiver from a FlexControl knob or a MIDI box, both
// of which a page can open itself. A surface that is not a piece of USB
// hardware cannot be: the desktop client offering itself as a TCI radio, so
// that JTDX or a logger connects to *it* and retunes this receiver, is a
// server listening on a socket — which no page can be.
//
// So the same arrangement as the radio transports (controls/radioProviders.js):
// whatever is hosting the page registers what it can be, the panel renders the
// fields it asks for, and the values travel back over the `sdrcontrol` topic.
// Nothing here knows what TCI is.

import { FIELD_TYPES } from './radioProviders.js';

// The key a handed-over audio port is tagged with. Named here so the page and
// whatever is listening for it agree without either hard-coding a string.
export const EVENT_AUDIO_PORT = 'ubersdr.audio-port';

// The same handover for spectrum frames. Its own name rather than a field on the
// audio one: a client may want either without the other, and they are opened by
// separate commands.
export const EVENT_SPECTRUM_PORT = 'ubersdr.spectrum-port';

const surfaces = new Map();    // id -> descriptor
const status = new Map();      // id -> last reported state
const listeners = new Set();

// The same field vocabulary the radio transports use, imported rather than
// repeated: two lists that were meant to be identical are two lists that will
// not be.

function emit() {
    const snapshot = listSurfaces();
    for (const fn of Array.from(listeners)) {
        try { fn(snapshot); } catch (e) { console.error('[ubersdr] surface listener threw', e); }
    }
}

/** Everything registered, in registration order, each with its last status. */
export function listSurfaces() {
    return Array.from(surfaces.values()).map((s) => ({
        ...s,
        status: status.get(s.id) || { running: false },
    }));
}

export function getProvidedSurface(id) {
    return surfaces.get(id) || null;
}

export function surfaceStatus(id) {
    return status.get(id) || { running: false };
}

/**
 * Sanitised on the way in, because this arrives from outside the page.
 *
 * Refused rather than repaired, for the reason the transports are: a surface
 * whose fields are half-understood renders a form that cannot be filled in
 * correctly, and the client is right there to be told.
 */
export function normaliseSurface(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('surface must be an object');
    const id = String(raw.id || '').trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(id)) {
        throw new Error('surface id must be 1-32 characters of [A-Za-z0-9_-]');
    }
    const fields = (Array.isArray(raw.fields) ? raw.fields : []).slice(0, 8).map((f) => {
        const key = String((f && f.key) || '').trim();
        if (!/^[a-z][a-z0-9_]{0,31}$/i.test(key)) throw new Error(`bad field key "${key}"`);
        const type = FIELD_TYPES.includes(f.type) ? f.type : 'text';
        return {
            key,
            label: String(f.label || key).slice(0, 40),
            type,
            placeholder: f.placeholder === undefined ? '' : String(f.placeholder).slice(0, 40),
            default: f.default === undefined ? (type === 'number' ? 0 : '') : f.default,
        };
    });
    return {
        id,
        label: String(raw.label || id).slice(0, 40),
        // What it says about itself, shown under the picker: a surface nobody
        // recognises by name is worth a sentence.
        description: String(raw.description || '').slice(0, 160),
        fields,
        // `audio` says it wants the receiver's sound as well as its controls —
        // a TCI server has to feed one to its clients. Asked for here so the
        // panel can say so, and so nothing is streamed to a surface that never
        // wanted it.
        audio: raw.audio === true,
    };
}

export function registerSurface(raw) {
    const surface = normaliseSurface(raw);
    surfaces.set(surface.id, surface);
    emit();
    return surface;
}

export function unregisterSurface(id) {
    const key = String(id || '');
    const had = surfaces.delete(key);
    status.delete(key);
    if (had) emit();
    return had;
}

/** What the surface says it is doing: running, how many clients, an error. */
export function setSurfaceStatus(id, next) {
    const key = String(id || '');
    if (!surfaces.has(key)) throw new Error(`no surface "${key}"`);
    const prev = status.get(key) || {};
    const merged = {
        running: next.running === undefined ? !!prev.running : !!next.running,
        clients: next.clients === undefined ? (prev.clients ?? 0) : Math.max(0, Number(next.clients) || 0),
        detail: next.detail === undefined ? (prev.detail ?? null) : (next.detail || null),
        error: next.error === undefined ? (prev.error ?? null) : (next.error || null),
    };
    status.set(key, merged);
    emit();
    return merged;
}

export function onSurfaces(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

// Test seam: the module is a singleton and a test registering a surface would
// otherwise leak it into the next one.
export function resetSurfaces() {
    surfaces.clear();
    status.clear();
    emit();
}
