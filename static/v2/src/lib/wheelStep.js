// One wheel gesture, one step — whatever the pointing device is.
//
// A mouse wheel sends one event per detent, so a handler that stepped once per
// event was right for it and only for it. A trackpad sends a stream of small
// deltas instead, dozens a second for a single two-finger swipe, and the same
// handler ran away: the frequency dial's digits blurred past several kHz for a
// gesture the hand read as a nudge.
//
// So measure the scroll in pixels rather than in events. Deltas accumulate
// until they cross a detent's worth of travel, which fires one step and clears
// the total — never more than one step per event, so a mouse detent (100 px in
// Chrome, three lines in Firefox) still steps exactly once and a trackpad has
// to be pushed a real distance for each one.

// A detent, in pixels of scroll. Under every mouse's per-notch delta — Chrome
// reports 100, Firefox three lines — so no mouse ever needs two notches to move
// one step, and far enough that a trackpad swipe is counted rather than
// multiplied.
export const WHEEL_NOTCH = 40;

// Wheel deltas come in three units, and only pixels are comparable to a
// threshold. The line and page figures are the usual approximations; they only
// have to be close, since both are already well past one detent.
export function wheelPixels(e) {
    if (e.deltaMode === 1) return e.deltaY * 16;    // lines
    if (e.deltaMode === 2) return e.deltaY * 400;   // pages
    return e.deltaY || 0;
}

/**
 * Makes a per-element wheel accumulator.
 *
 * Call the returned function with each wheel event; it returns +1 (scroll up),
 * -1 (scroll down) or 0 for the events that have not yet added up to a step.
 * Direction follows the dial's digits — scrolling up means up — rather than the
 * sign of deltaY, which points the other way.
 *
 * State is per accumulator, so give each control its own.
 */
export function createWheelStep(notch = WHEEL_NOTCH) {
    let acc = 0;
    return (e) => {
        const px = wheelPixels(e);
        if (!px) return 0;
        // Reversing means the previous direction's leftovers are stale: kept,
        // they would make the first step back the other way come early.
        if ((px < 0) !== (acc < 0)) acc = 0;
        acc += px;
        if (Math.abs(acc) < notch) return 0;
        const dir = acc < 0 ? 1 : -1;
        acc = 0;
        return dir;
    };
}
