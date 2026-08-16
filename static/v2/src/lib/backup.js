// Everything this browser remembers about the receiver, in one file.
//
// The settings themselves live in a dozen module singletons — display, layout,
// mappings, shortcuts, VFOs, announcements — and each owns its localStorage key
// and knows nothing about the others. This is the one list of those keys, so
// the Backup panel is generated from it rather than written out, and a store
// added later needs a line here and nothing else.
//
// Two rules make that arrangement safe rather than merely tidy:
//
//   * A key under `ubersdr.v2.` that no section claims is exported anyway,
//     under "Other". Forgetting to add the line is then a cosmetic mistake —
//     the setting appears in the wrong group — rather than a backup that is
//     quietly missing something, which is worse than no backup at all.
//
//   * Passwords are never exported. A settings file is something people email
//     to themselves and paste into forums, and the rotator and antenna
//     passwords are the operator's, not the listener's. They are listed in
//     SECRETS so the sweep above cannot pick one up by accident.
//
// Nothing here touches the DOM or IndexedDB: local bookmarks live in a database
// shared with v1 and are read and written by the panel, which passes the array
// through. That keeps this module a pure function of localStorage, which is
// what makes it testable.

export const APP = 'ubersdr-v2';

// The envelope's version, not the app's. Bump it only when the shape of the
// file changes in a way a reader has to know about; a new section is not that,
// because sections are matched by key and an unknown one is reported rather
// than fatal.
export const VERSION = 1;

const PREFIX = 'ubersdr.v2.';

// Never exported, never swept up by the "Other" section, never written back by
// an import.
//
// Every one of these is either a v1 key or in sessionStorage, so none of them
// could reach a bundle by the routes above as they stand. They are named
// anyway: "this key is deliberately not in the backup" is a decision, and a
// decision that holds only because of where a value happens to be stored today
// is one key move away from being wrong silently. Listing it here also means
// that if a section ever claims one, keysFor filters it back out.
// Two kinds, and the difference is *whose* they are.
//
// An instance secret is the receiver's: the rotator on that operator's desk,
// the antenna switch in that operator's garden, the bypass password for that
// receiver. Carrying one to another receiver would be handing a credential to
// a machine it does not belong to, so the desktop and mobile clients — which
// otherwise copy the whole interface between receivers — must not carry these.
export const INSTANCE_SECRETS = [
    'rotctl_password',          // rotator, v1 and v2
    'ant_switch_password',      // antenna switch, v1 and v2
    'ubersdr_bypass_password',  // v1's session bypass
    'ubersdr.v2.password',      // v2's session bypass — sessionStorage, not local
];

// A user secret is the operator's own account with somebody else: it has
// nothing to do with which receiver is being listened to, and typing it again
// for every receiver would be a chore with no safety bought by it. These do
// travel between receivers in the apps — see the clients' shared-settings
// code — and, like every secret here, still never appear in a backup file.
export const USER_SECRETS = [
    'rmnoise_password',         // v1's RM Noise login
    'ubersdr.v2.rmnoise',       // v2's, which carries the password with it
];

// What a backup may never contain, which is both kinds.
export const SECRETS = [...INSTANCE_SECRETS, ...USER_SECRETS];

// `keys` is exhaustive for the section. `rest: true` marks the sweep, and
// `bookmarks: true` the one section that is not localStorage at all.
export const SECTIONS = [
    {
        id: 'receiver',
        label: 'Receiver settings',
        hint: 'Frequency, mode, filters, volume, AGC, squelch',
        keys: ['ubersdr.v2.radio'],
    },
    {
        id: 'vfos',
        label: 'VFOs',
        hint: 'What A, B, C and D are holding',
        keys: ['ubersdr.v2.vfos'],
    },
    {
        id: 'display',
        label: 'Display',
        hint: 'Palette, spectrum and waterfall settings, theme, scale',
        keys: ['ubersdr.v2.display'],
    },
    {
        id: 'layout',
        label: 'Panel layout',
        hint: 'Which panels are where, and the floating windows',
        keys: ['ubersdr.v2.layout', 'ubersdr.v2.extensions', 'ubersdr.v2.stt.caption'],
    },
    {
        id: 'controls',
        label: 'MIDI & FlexControl',
        // v1's keys travel with v2's: the mapping record is the same in both
        // frontends, and someone restoring a backup wants their knobs working
        // in whichever one they open.
        hint: 'Mappings, step size, device and Radio Sync',
        keys: [
            'ubersdr.v2.radioControl',
            'ubersdr_midi_mappings', 'ubersdr_midi_step_hz', 'ubersdr_midi_device',
            'ubersdr_flexcontrol_mappings', 'ubersdr_flexcontrol_step_hz',
        ],
    },
    {
        id: 'shortcuts',
        label: 'Keyboard shortcuts',
        hint: 'Every key you have bound, and whether they are on',
        keys: ['ubersdr.v2.shortcuts'],
    },
    {
        id: 'announce',
        label: 'Announcements',
        hint: 'Spoken frequency and mode, and the voice',
        keys: ['ubersdr.v2.announce'],
    },
    {
        id: 'media',
        label: 'Media controls',
        hint: 'Lock screen and media key settings',
        keys: ['ubersdr.v2.media'],
    },
    {
        id: 'chat',
        label: 'Chat',
        hint: 'Your name and the chime',
        keys: ['ubersdr.v2.chatName', 'ubersdr.v2.chatChime'],
    },
    {
        id: 'bookmarks',
        label: 'Local bookmarks',
        hint: 'The ones saved in this browser, shared with the old interface',
        bookmarks: true,
    },
    {
        id: 'other',
        label: 'Other',
        hint: 'Anything else v2 has saved here',
        rest: true,
    },
];

export function sectionById(id) {
    return SECTIONS.find((s) => s.id === id) || null;
}

// --- localStorage, defensively ----------------------------------------------
//
// Read through a function rather than captured at import: private mode throws
// on access in some browsers, and the tests install their own.

function ls() {
    try { return globalThis.localStorage || null; } catch (e) { return null; }
}

export function allKeys() {
    const s = ls();
    if (!s) return [];
    const out = [];
    for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k) out.push(k);
    }
    return out;
}

const claimedKeys = () => new Set(SECTIONS.flatMap((s) => s.keys || []));

/** The keys this section covers *in this browser* — the sweep needs to look. */
export function keysFor(id) {
    const sec = sectionById(id);
    if (!sec) return [];
    if (sec.keys) return sec.keys.filter((k) => !SECRETS.includes(k));
    if (sec.rest) {
        const known = claimedKeys();
        return allKeys().filter(
            (k) => k.startsWith(PREFIX) && !known.has(k) && !SECRETS.includes(k),
        );
    }
    return [];
}

/** Which section a key belongs to, or null if it is not ours to restore. */
export function sectionFor(key) {
    if (!key || SECRETS.includes(key)) return null;
    for (const s of SECTIONS) {
        if (s.keys && s.keys.includes(key)) return s.id;
    }
    return key.startsWith(PREFIX) ? 'other' : null;
}

// --- values -----------------------------------------------------------------
//
// Stored values are strings, and almost all of them are JSON. They are unpacked
// on the way out so the file can be read and edited by a person, which is half
// of what a settings export is for.
//
// Only objects and arrays are unpacked. A stored `"500"` stays the string
// `"500"` rather than becoming the number 500, so what goes back into
// localStorage is what came out of it.

function decode(raw) {
    try {
        const v = JSON.parse(raw);
        return v !== null && typeof v === 'object' ? v : raw;
    } catch (e) {
        return raw;
    }
}

function encode(value) {
    return typeof value === 'string' ? value : JSON.stringify(value);
}

/** How many of a section's keys this browser actually has. */
export function presentCount(id) {
    const s = ls();
    if (!s) return 0;
    return keysFor(id).filter((k) => s.getItem(k) != null).length;
}

// --- export -----------------------------------------------------------------

/**
 * The file, as an object. `extra.bookmarks` is the array the panel read out of
 * IndexedDB, included only when the bookmarks section is selected.
 */
export function buildBundle(ids, extra = {}) {
    const chosen = new Set(ids);
    const s = ls();
    const items = {};
    for (const sec of SECTIONS) {
        if (sec.bookmarks || !chosen.has(sec.id)) continue;
        for (const k of keysFor(sec.id)) {
            const raw = s && s.getItem(k);
            if (raw == null) continue;
            items[k] = decode(raw);
        }
    }
    const bundle = { app: APP, version: VERSION, exported: new Date().toISOString(), items };
    if (chosen.has('bookmarks') && Array.isArray(extra.bookmarks)) {
        bundle.bookmarks = extra.bookmarks;
    }
    return bundle;
}

export function bundleFilename(now = new Date()) {
    return `ubersdr-settings-${now.toISOString().slice(0, 10)}.json`;
}

// --- import -----------------------------------------------------------------

/**
 * What a file contains, before anything is written.
 *
 * Returns `{ ok: false, error }` for something that is not one of ours, and
 * otherwise a per-section breakdown to show the operator. A file from a newer
 * version is a warning rather than a refusal: sections are independent, so the
 * parts this build understands restore correctly and the rest is listed as
 * unrecognised.
 */
export function inspect(bundle) {
    // A bookmark export is a bare array, and a KiwiSDR list has a `dx` array.
    // Both are files someone might reasonably try here, so they get told where
    // the file does belong rather than that it is unrecognised.
    if (Array.isArray(bundle) || (bundle && bundle.dx)) {
        return {
            ok: false,
            error: 'That looks like a bookmarks file — the Local bookmarks panel imports those.',
        };
    }
    if (!bundle || typeof bundle !== 'object' || bundle.app !== APP) {
        return { ok: false, error: 'That file is not an UberSDR settings backup.' };
    }
    const items = bundle.items && typeof bundle.items === 'object' ? bundle.items : {};

    const counts = new Map();
    const unknown = [];
    for (const key of Object.keys(items)) {
        const id = sectionFor(key);
        if (!id) { unknown.push(key); continue; }
        counts.set(id, (counts.get(id) || 0) + 1);
    }
    const hasBookmarks = Array.isArray(bundle.bookmarks);
    if (hasBookmarks) counts.set('bookmarks', bundle.bookmarks.length);

    const version = Number(bundle.version) || 0;
    return {
        ok: true,
        version,
        exported: typeof bundle.exported === 'string' ? bundle.exported : '',
        // Only worth saying when it could explain something missing.
        warning: version > VERSION
            ? `Written by a newer version of UberSDR (${version}). Anything it added is listed as unrecognised.`
            : '',
        sections: SECTIONS
            .filter((s) => counts.has(s.id))
            .map((s) => ({ id: s.id, label: s.label, count: counts.get(s.id) })),
        unknown,
    };
}

/**
 * Write the selected sections into localStorage. Bookmarks are the panel's job.
 *
 * `merge` writes what the file has and leaves everything else alone. `replace`
 * additionally clears the keys of the selected sections that the file does not
 * mention, so restoring a backup taken before a mapping was added removes that
 * mapping instead of leaving it behind.
 *
 * Nothing here takes effect until the page is reloaded: every store read its
 * key once at startup and would write its own copy back over this one.
 */
export function applyBundle(bundle, ids, mode = 'merge') {
    const s = ls();
    if (!s) throw new Error('This browser will not let the page store settings.');

    const chosen = new Set(ids);
    const items = bundle && bundle.items && typeof bundle.items === 'object' ? bundle.items : {};
    const has = (k) => Object.prototype.hasOwnProperty.call(items, k);
    let written = 0;
    let removed = 0;

    if (mode === 'replace') {
        for (const id of chosen) {
            for (const k of keysFor(id)) {
                if (has(k) || s.getItem(k) == null) continue;
                s.removeItem(k);
                removed++;
            }
        }
    }

    for (const [key, value] of Object.entries(items)) {
        const id = sectionFor(key);
        if (!id || !chosen.has(id)) continue;
        try {
            s.setItem(key, encode(value));
        } catch (e) {
            // Almost always the quota. Said out loud rather than swallowed: a
            // half-restored backup that reported success is how someone spends
            // an evening wondering where their mappings went.
            throw new Error(`Could not write ${key} — ${e.message || 'storage refused it'}`);
        }
        written++;
    }

    return { written, removed };
}
