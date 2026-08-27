// Whether the spectrum view holds the dial in the middle.
//
// This is a display setting, but the code that acts on it is RadioContext's
// auto-recentre — a plain function inside applyTuning, reached from every
// tuning path in the app and mostly from outside React's render: the wheel, a
// drag on the waterfall, the keyboard, a control surface, the scanner, CAT.
//
// So the value is pushed here when it changes and read here when a tune lands,
// rather than RadioProvider subscribing to DisplayContext. Subscribing would
// re-run the whole receiver on every display change — a contrast slider being
// dragged is sixty of those a second — to learn one boolean that changes when
// somebody presses a button. lib/haptics.js has the same shape for the same
// reason, and HapticWatch's note on it says it in the other direction.

let centered = false;

/** Mirror the display setting. Called by DisplayProvider, and by tests. */
export function setDialCentered(on) {
    centered = !!on;
}

/**
 * Does the view follow the dial into the middle on every tune?
 *
 * Not `dialCentered`, which is what the setting itself is called: test/unresolved.js
 * matches an exported name anywhere it appears unqualified, and an object key is
 * unqualified — so a getter of that name would be reported as a missing import
 * in every file that writes the setting. The check is worth more than the
 * symmetry.
 */
export function dialIsCentered() {
    return centered;
}
