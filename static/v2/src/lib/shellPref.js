// Which layout to draw: the docks, or one panel at a time.
//
// Its own localStorage key rather than a field in the display settings, and the
// reason is where it is set from. In the apps this is chosen in two places —
// the start overlay, and the chooser's own settings page, which is a different
// page in a different origin and knows nothing about v2's internals. A whole
// settings blob is not something a host can safely reach into and patch; a key
// holding one word is.
//
// `ubersdr.v2.` so it travels with the rest: every client's prefs machinery
// syncs that prefix (see clients/capacitor/src/receiver.js and prefs.js in the
// desktop client), so a layout chosen on one receiver is the layout the next
// one opens with, and a layout chosen in the chooser is seeded into the page
// before its first script runs.

const KEY = 'ubersdr.v2.shell';

const listeners = new Set();

/** 'full', 'minimal', or null for "never chosen". */
export function readShell() {
    try {
        const value = localStorage.getItem(KEY);
        return value === 'minimal' || value === 'full' ? value : null;
    } catch (e) {
        return null;
    }
}

export function writeShell(value) {
    const next = value === 'minimal' ? 'minimal' : 'full';
    try { localStorage.setItem(KEY, next); } catch (e) { /* private mode */ }
    for (const fn of listeners) {
        try { fn(next); } catch (e) { console.error('shell listener threw', e); }
    }
}

export function onShell(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/**
 * Which layout is in force: 'full' (docks) or 'minimal' (tabs and sheets).
 *
 * A narrow screen is always minimal, whatever is stored, and that is not a
 * default being applied — it is the only layout that fits. Three docks and a
 * spectrum do not go into 390 px, so honouring a stored 'full' there would be
 * honouring a request to make the receiver unusable. It is a reachable state,
 * too: the apps share one settings blob between a tablet and a phone.
 *
 * Everywhere else the choice decides, and never having chosen means the docks.
 */
export function resolveShell(value, narrow) {
    if (narrow) return 'minimal';
    return value === 'minimal' ? 'minimal' : 'full';
}

/**
 * Is choosing worth offering here?
 *
 * Both layouts have to be possible, and the machine has to be one where the
 * question is real. A machine driven by a pointer is what the docks are *for* —
 * the tabbed layout exists because a fingertip cannot work a dock, not because
 * a screen is small. What is left is a touchscreen with room for both, which is
 * a tablet: the one machine that has been having this decided for it.
 *
 * `roomy` is about the device rather than the moment — see SHELL_ROOM_QUERY.
 * Asking whether the docks fit *right now* made the control vanish whenever a
 * tablet was held in portrait, which is both surprising and the orientation
 * somebody is most likely to be in when they decide the docks are too fiddly.
 */
export function shellChoosable({ touch, roomy }) {
    return !!touch && !!roomy;
}
