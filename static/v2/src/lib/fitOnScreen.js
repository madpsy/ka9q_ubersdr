// Keeping a floating window on a screen that has just got shorter.
//
// A floating window is placed by hand and remembered where it was put, which is
// right until the space it was put in stops existing. That happens for one
// reason on a desktop — the browser window resized — and constantly on a
// tablet, because both apps shorten the page for the keyboard (SystemBars.java
// and ReceiverViewController). A window sitting two thirds of the way down a
// 1160 pt page is off the bottom of a 593 pt one, which looks exactly like the
// keyboard covering it and is really the page ending above it.
//
// So the *drawn* position is clamped while the stored one is left alone. That
// distinction is the whole design: a keyboard is a moment, and a window that
// had to move for one must go back where it was put when the keyboard goes.
// Writing the clamp into the layout would make a transient into a decision, and
// after a few frequency entries every window would have migrated up the screen.

/** How much of a window must stay on screen: its header, near enough. */
export const KEEP_VISIBLE = 44;

/**
 * Where to draw a window whose stored position is `y`, given a viewport `vh`
 * tall and a window `h` tall.
 *
 * Pulled up only as far as it needs to be and never past the top: a window
 * taller than the viewport keeps its top edge, because the top is where its
 * header and its first controls are.
 */
export function fitY(y, h, vh) {
    if (!(vh > 0)) return y;
    // The lowest it may start and still show something of itself.
    const lowest = Math.max(0, vh - Math.max(KEEP_VISIBLE, Math.min(h || 0, vh)));
    return Math.max(0, Math.min(y, lowest));
}

/** The same for x, so a narrow viewport cannot leave a window off to the side. */
export function fitX(x, w, vw) {
    if (!(vw > 0)) return x;
    const rightmost = Math.max(0, vw - Math.max(KEEP_VISIBLE, Math.min(w || 0, vw)));
    return Math.max(0, Math.min(x, rightmost));
}
