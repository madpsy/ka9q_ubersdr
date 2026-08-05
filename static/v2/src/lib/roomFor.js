// The measurement behind useRoomFor, without the hook around it.
//
// Separate so it can be tested: the hook needs React and a live DOM, this needs
// an element-shaped object and answers the only question that is hard to get
// right — which optional children of a flex row still fit.
//
// The answer is worked out from the row's *other* children, never from the row
// as it stands, and that is the whole trick: measure the row with an optional
// child in it and hiding the child frees exactly the space that then says it
// fits, so it blinks on and off once a render, forever. Summing everything else
// is a figure that does not move when the child comes and goes.
//
// Children are marked with data attributes:
//
//   data-optional="<key>"  an optional child, named so that several of them can
//                          share one row. Measured whenever it is up, and its
//                          last width is remembered for while it is not.
//   data-slack             a flex spacer. Skipped — it is room, not content,
//                          and its width is whatever is left over, which would
//                          otherwise make every row look exactly full.
//
// Two things the row's own CSS has to hold up, because nothing here can check
// them:
//
//   * a child that is counted must be the width it says it is. A flex child that
//     shrinks below its content reports the shrunken box, so the figure that is
//     supposed to hold still falls in step with the window and the optional
//     children are never dropped — they just get drawn on top of. Non-optional
//     children of a measured row want `flex: none` and a bounded width.
//   * an optional child is absent from the DOM when it does not fit, not merely
//     invisible. A `visibility: hidden` child still measures.
//
// An optional child does not have to be a direct child of the row. The top bar's
// filter width sits inside the frequency readout, beside the mode it belongs to,
// and a nested one has to be discounted from the ancestor it is inside or the
// invariant above is broken in the one way that matters: its width is inside a
// figure that is supposed to hold still, so the row oscillates and React gives
// up with "Maximum update depth exceeded".

// Kept in hand so a child is only shown with room to spare. Without it a row
// whose other children can shrink — a top bar with a truncating name in it —
// takes the last few pixels for the optional child and squeezes them instead.
const CUSHION = 8;

const gapOf = (el) => parseFloat(getComputedStyle(el).columnGap) || 0;

/**
 * What a direct child contributes to the row, discounting any optional children
 * nested inside it — and recording what those cost, since a nested child is
 * never seen by the loop over the row's own children.
 *
 * A nested child costs its parent its own width *and* one of the parent's gaps:
 * remove it and the row gives back both.
 */
function costOf(child, widths) {
    let w = child.offsetWidth;
    const inside = child.querySelectorAll('[data-optional]');
    if (!inside.length) return w;

    const innerGap = gapOf(child);
    for (const el of inside) {
        const cost = el.offsetWidth + innerGap;
        widths[el.dataset.optional] = { w: cost, nested: true };
        w -= cost;
    }
    return w;
}

/**
 * @param el     the row.
 * @param specs  [{ key, width }] in *keep* order: most important first, so the
 *               last is the first to go as the row narrows. `width` stands in
 *               until that child has been on screen once to be measured.
 * @param widths the width cache, `{ key: { w, nested } }`, read and written.
 *               Held across renders by the caller so a child that is hidden
 *               right now still asks for the space it actually had.
 * @returns      { key: boolean }
 */
export function measureRoom(el, specs, widths) {
    const cs = getComputedStyle(el);
    const gap = parseFloat(cs.columnGap) || 0;
    const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);

    let used = 0;
    let count = 0;
    for (const child of el.children) {
        if (child.dataset.slack != null) continue;
        if (child.dataset.optional != null) {
            widths[child.dataset.optional] = { w: child.offsetWidth, nested: false };
            continue;
        }
        used += costOf(child, widths);
        count += 1;
    }

    const avail = el.clientWidth - pad;
    const fits = {};
    for (const s of specs) {
        const rec = widths[s.key];
        const w = (rec && rec.w) || s.width;
        // A nested child grows a box the row already has, so it neither adds a
        // box nor costs one of the row's own gaps.
        const nested = !!(rec && rec.nested);
        const gaps = nested ? Math.max(0, count - 1) : count;

        // n items already placed, plus this one, needs n gaps between them.
        if (used + w + gap * gaps + CUSHION <= avail) {
            fits[s.key] = true;
            used += w;
            if (!nested) count += 1;
        } else {
            fits[s.key] = false;
        }
    }
    return fits;
}

export function sameFits(a, b) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}
