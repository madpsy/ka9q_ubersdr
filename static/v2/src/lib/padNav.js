// The Multipad by remote control: up and down walk every control, in order.
//
// A television's D-pad moves focus by geometry, and on this pad geometry loses
// controls. The zoom drum takes left and right — that is how it zooms — and the
// noise reduction picker sits to its right on the same line, so right was the
// only way there and the drum had it. Up and down from the rows around land on
// the drum, the widest thing on that line. The width slider beside the squelch
// in the minimal view was cut off the same way, as were Auto and the width
// reset. Anything to the right of a drum or a slider could not be reached.
//
// So on a television the pad stops asking geometry. Up and down step through
// the pad's controls in the order they are drawn, one stop each, and leave the
// pad at either end; left and right are left to the control, which is what the
// drums and sliders want them for. Nothing on the pad is more than a run of
// down-presses away, and none of it depends on what happens to sit beside what.
//
// A row of buttons — the modes, the bands, the view, the marker types — is one
// stop rather than one per button, or reaching the squelch from the frequency
// would be thirty presses. Up or down lands on the row's selected button, and
// left and right move along the row, carried on across the lines where it
// wraps: the bands take two or three, and geometry going right off the end of
// the first would find nothing to the right of it and stop.
//
// Pure: `items` is the pad's focusable controls in document order, each
// { el, group, active } — `group` is whatever identifies its row of buttons
// (null for a control of its own) and `active` whether it is the selected one.
// The DOM half lives with the panel.

/** Consecutive members of one group collapse into a single stop. */
export function padStops(items) {
    const stops = [];
    for (const item of items) {
        const last = stops[stops.length - 1];
        if (item.group != null && last && last.group === item.group) last.items.push(item);
        else stops.push({ group: item.group, items: [item] });
    }
    return stops;
}

// Where focus lands on arriving at a stop: the selected button of a row, or
// its first where none is (or several are, as with the marker types).
function landing(stop) {
    const active = stop.items.filter((i) => i.active);
    return (active.length === 1 ? active[0] : stop.items[0]).el;
}

/**
 * The element up (`dir` -1) or down (+1) from `current`, or null past either
 * end of the pad — where the caller hands the key back to the page. Also null
 * when `current` is not one of the items.
 */
export function nextStop(items, current, dir) {
    const stops = padStops(items);
    const at = stops.findIndex((s) => s.items.some((i) => i.el === current));
    if (at < 0) return null;
    const to = stops[at + dir];
    return to ? landing(to) : null;
}

/**
 * The element left (-1) or right (+1) of `current` along its row of buttons,
 * or null: at an end of the row, or for a control that is not in a row, whose
 * left and right are its own business.
 */
export function stepInRow(items, current, dir) {
    const stop = padStops(items).find((s) => s.items.some((i) => i.el === current));
    if (!stop || stop.group == null) return null;
    const at = stop.items.findIndex((i) => i.el === current);
    const to = stop.items[at + dir];
    return to ? to.el : null;
}
