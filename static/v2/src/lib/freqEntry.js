// "Open the frequency box", as a request rather than a call.
//
// v1's F key focused the frequency input; here the same thing has to reach a
// piece of local state inside TopBar from ShortcutWatch, which is mounted once
// beside the announcers and knows nothing about the bar — and from a MIDI pad or
// the FlexControl, which know even less. A module-level listener list is the same
// arrangement the in-app callsign lookups use, and for the same reason: the
// sender should not have to hold a reference to a component that may not be
// mounted.
//
// Only the top bar answers. The Receiver panel's dial and the Multipad carry the
// same FreqEntry box, but a request that opened all three at once would leave two
// of them focused for no reason, and the bar is the one part of the interface that
// is always on screen.

const listeners = new Set();

/** Registered by whatever hosts the box — see TopBar. */
export function onFreqEntry(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/**
 * Ask for the frequency box, open and ready to be typed into.
 *
 * Returns false when nothing was listening, so a caller can say so rather than
 * leaving a key that appears to do nothing: a handset held on its side draws no
 * top bar at all (see MobileShell).
 */
export function requestFreqEntry() {
    if (listeners.size === 0) return false;
    for (const fn of [...listeners]) {
        try { fn(); } catch (e) { console.error('frequency entry listener threw', e); }
    }
    return true;
}

/** Test seam. */
export function _resetFreqEntry() {
    listeners.clear();
}
