// Which panel, if any, is pinned to the top of a dock.
//
// Pinning makes the first panel in a side dock stay where it is while the rest
// scroll under it — the panel you keep coming back to (the receiver, the signal
// meter) is then never the one that has just gone off the top.
//
// Two rules, and they are the whole feature:
//
//   - only the top panel, and only in a dock that is a column. The bottom dock
//     lays its panels out in a row, where there is no "under" for the others to
//     go and nothing above to hold still.
//   - stored by panel id rather than as "whatever is top". Reordering then
//     cannot silently hand the pin to a different panel: it stops applying, and
//     applies again if that panel comes back to the top, so the arrow that moved
//     it is also the way back.
//
// Asked in two places — the dock, which makes the section sticky, and the
// section header, which lights the button — so it lives here rather than in
// either of them.

export const PINNABLE = ['left', 'right'];

/** Whether this placement may offer a pin at all. */
export function canPin(side, index) {
    return PINNABLE.includes(side) && index === 0;
}

/**
 * The pinned panel in one dock, or null.
 *
 * @param pins     the layout's `pins` map, keyed by dock side.
 * @param side     which dock.
 * @param visible  the ids actually drawn in it, in order — not the stored list,
 *                 which may hold panels that are hidden or that do not apply to
 *                 this receiver. A pin on one of those is inert rather than
 *                 wrong: nothing is drawn to pin.
 */
export function pinnedPanel(pins, side, visible) {
    if (!PINNABLE.includes(side)) return null;
    const id = pins && pins[side];
    if (!id || !visible || visible[0] !== id) return null;
    return id;
}
