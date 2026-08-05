// Whether the Callsign lookup panel shows the operator's photo.
//
// A setting rather than a preference buried in the display panel: it is about
// this panel, and the reason to turn it off is usually the picture itself —
// a shack photo is a few hundred kilobytes, and on a metered link or a small
// dock it is the largest thing on screen for the least information.
//
// The lookup itself is unaffected; only the picture is.

const KEY = 'ubersdr.v2.callsignPhoto';

export function photoShown() {
    try {
        return localStorage.getItem(KEY) !== 'off';
    } catch (e) {
        return true;
    }
}

export function setPhotoShown(on) {
    try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch (e) { /* private mode */ }
    for (const fn of Array.from(listeners)) fn(!!on);
    return !!on;
}

// Both the form and the result read this, and they are separate components.
const listeners = new Set();

export function onPhotoShown(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}
