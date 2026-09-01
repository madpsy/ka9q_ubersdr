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
//     One exception is handled rather than asked for, because a row can want it:
//     a child that clips (`overflow: hidden`) is counted at the width it needs,
//     not the width it was given — see widthOf.
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
 * How wide a child is, whatever kind of element it is.
 *
 * `offsetWidth` is defined on HTMLElement, and an inline SVG icon is an
 * SVGElement — so reading it on one gives `undefined` in the browsers that
 * follow the spec. That is not a small error: one undefined in the sum below
 * makes the whole figure NaN, every comparison against it is false, and the
 * row's optional children are hidden at *every* width, on a row with plenty of
 * space, with nothing on screen to say why.
 *
 * Every row that used this until now happened to be all spans. The IQ panel's
 * demodulator rows lead with a chevron, and that is how this was found.
 *
 * The rect is rounded up to match what offsetWidth would have given, so a row
 * of ordinary elements measures exactly as it always did.
 */
function widthOf(el) {
    const w = el.offsetWidth;
    let box;
    if (typeof w === 'number') {
        box = w;
    } else {
        const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
        box = rect ? Math.ceil(rect.width) : 0;
    }

    // A child that clips its own content reports the box it was *given* rather
    // than the width it needs, and the two stop agreeing at exactly the moment
    // this is being asked. The IQ panel's row header is the case: the label
    // button is `overflow: hidden` with `min-width: 0`, so once the row is short
    // of space the button shrinks instead of the row overflowing — and its
    // measured width then falls in step with the window. That is the failure
    // the note at the top of this file describes: the figure that is supposed to
    // hold still moves, so nothing is ever dropped and the tags are drawn on top
    // of instead. On screen it looks like the panel ignoring the width entirely.
    //
    // The overflow is exactly what was clipped, so adding it back gives the
    // width the child would have taken if it had been allowed to. An element
    // that is not clipping has scrollWidth equal to clientWidth and is left
    // alone, which is every row that used this before.
    const { scrollWidth, clientWidth } = el;
    if (typeof scrollWidth === 'number' && typeof clientWidth === 'number'
        && scrollWidth > clientWidth) {
        box += scrollWidth - clientWidth;
    }
    return box;
}

/**
 * What a direct child contributes to the row, discounting what is inside it that
 * is not its own content — and recording what the optional part of that cost,
 * since a nested child is never seen by the loop over the row's own children.
 *
 * Anything discounted costs its parent its own width *and* one of the parent's
 * gaps: remove it and the row gives back both.
 *
 * Two kinds are discounted, for one reason. The row is only measurable if every
 * counted child is the width it says it is, and both of these are children that
 * are not:
 *
 *   an optional child   because it is the thing being decided about, so a figure
 *                       that included it would move as the answer moved.
 *   a nested spacer     because a box holding one is as wide as the row let it
 *                       be rather than as wide as its content. The IQ panel's
 *                       demodulator rows are the case: the head is the measured
 *                       row and the button in it grows to fill, so without this
 *                       the button reports the whole row and there is never
 *                       space for anything. Taking the spacer out leaves the
 *                       button's own content, which is the figure that holds
 *                       still.
 */
function costOf(child, widths) {
    let w = widthOf(child);
    const inside = child.querySelectorAll('[data-optional]');
    const spacers = child.querySelectorAll('[data-slack]');
    if (!inside.length && !spacers.length) return w;

    const innerGap = gapOf(child);
    for (const el of inside) {
        const cost = widthOf(el) + innerGap;
        widths[el.dataset.optional] = { w: cost, nested: true };
        w -= cost;
    }
    // A spacer of no width still costs the gap beside it, so this subtracts one
    // even when the row is full and there is nothing left for it to hold.
    for (const el of spacers) w -= widthOf(el) + innerGap;
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
 * @param shown  what is up right now, `{ key: boolean }` — which decides which
 *               of two questions each child is asked. See below.
 * @returns      { key: boolean }
 */
export function measureRoom(el, specs, widths, shown = {}) {
    const cs = getComputedStyle(el);
    const gap = parseFloat(cs.columnGap) || 0;
    const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);

    let used = 0;
    let count = 0;
    for (const child of el.children) {
        if (child.dataset.slack != null) continue;
        if (child.dataset.optional != null) {
            widths[child.dataset.optional] = { w: widthOf(child), nested: false };
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

        // Two questions, not one, and this is the difference between a row that
        // settles and a row that cannot.
        //
        // Asking "does it fit" of a child that is already up, with the same
        // cushion that let it in, means a row sitting near the boundary drops
        // it — and the moment it is gone there is room again, so it comes back,
        // and so on for ever. That is not a flicker: each answer is a state
        // change, so React re-renders, measures, and changes its mind again
        // until it gives up and throws (#185), taking the interface with it.
        // The top bar did exactly that on a phone once its buttons grew for
        // touch and the row came to rest on the line.
        //
        // So: something already shown keeps its place while it merely fits, and
        // something hidden has to clear the cushion before it comes back. The
        // same hysteresis fitsInHeader has, for the same reason.
        const room = shown[s.key] ? 0 : CUSHION;
        if (used + w + gap * gaps + room <= avail) {
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
