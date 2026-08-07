// Which panel had the keyboard, per dock, so a dock that hides and comes back gives it
// to the same one.
//
// The case is the bottom dock collapsed to a rail and peeked at by hovering: a peek is a
// fresh mount every time, so whatever was focused is gone and the next panel that grabs
// focus on mount wins. With a chat box and a cluster command line side by side, that
// meant typing into chat, glancing away, and finding the next keystroke in the cluster.
//
// The fix is in two halves and both are needed. This is the half that remembers; the
// other is panels not taking focus on mount just because they happen to be connected —
// see the note in DXClusterPanel.
//
// Deliberately a *panel*, not an element. The element is unmounted by the time this is
// asked, and its replacement is a different object with no relationship to it beyond
// being in the same panel — so the promise is "the panel you were typing in", which is
// what somebody actually means by where they were.

// dock side -> panel id.
const lastFocused = new Map();

// What a panel offers the keyboard back to. A panel with several inputs says which one
// with this; without it, the first text field in the panel is a fair guess.
const MARK = '[data-dock-focus]';
const FALLBACK = 'input:not([type=hidden]):not([disabled]), textarea:not([disabled])';

/** Remember, from anything inside a panel — an event target will do. */
export function noteDockFocus(side, el) {
    if (!side || !el || !el.closest) return;
    const section = el.closest('[data-panel]');
    if (!section) return;
    const id = section.getAttribute('data-panel');
    if (id) lastFocused.set(side, id);
}

/** Which panel it was, or ''. */
export const dockFocusPanel = (side) => lastFocused.get(side) || '';

export function forgetDockFocus(side) {
    lastFocused.delete(side);
}

/**
 * Give the keyboard back, if this dock had it.
 *
 * `preventScroll`, because the dock restores its scroll position in the same commit and
 * a browser scrolling a freshly focused input into view would undo that — see the
 * scroll note in Dock.
 *
 * Nothing happens when something outside is already focused and it is not ours to take:
 * a dock reopening must not pull the keyboard out of the frequency box or the chat in a
 * floating window. Only an unfocused document, or a focus still inside this dock, counts
 * as the keyboard being free.
 */
export function restoreDockFocus(side, root) {
    const id = dockFocusPanel(side);
    if (!id || !root) return false;
    const active = document.activeElement;
    const free = !active || active === document.body || root.contains(active);
    if (!free) return false;
    const section = root.querySelector(`[data-panel="${id}"]`);
    if (!section) return false;
    const target = section.querySelector(MARK) || section.querySelector(FALLBACK);
    if (!target || target === active) return false;
    try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); }
    return true;
}

/** Test seam. */
export function _resetDockFocus() {
    lastFocused.clear();
}
