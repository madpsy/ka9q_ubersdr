// How much empty space is left in a title bar, and whether one more control fits.
//
// This replaces a threshold on the panel's width, which was the wrong question
// asked for the right reason. The right reason: a title bar cannot be measured
// naively, because the thing that gives way when it runs out of room — the panel
// title, an ellipsis in a flexible box — shrinks in step with everything else, so
// summing what is in the row gives a figure that never says "too much". The
// wrong answer: judge the panel instead, since a panel's width comes from its
// dock and cannot be pushed about by its own header. That holds still, and it is
// a guess. A 320px dock and a 320px window leave quite different amounts of room
// in the bar, "Callsign lookup" needs twice the room "Audio" does, and no single
// number is right for all of them. It showed: with the pair set to appear above
// 270px of panel, side docks at their default width sat just under the line and
// never showed it at all.
//
// So: measure the space, not the box. The trick is to measure the elastic child
// by its *content* — a truncated title reports the full width of its text in
// scrollWidth, whatever the box around it has been squeezed to — and everything
// else by its box. What is left over is the genuine slack in the bar, the same
// slack somebody looking at it can see, and it does not depend on how hard the
// title has been squeezed.
//
// ── Holding still ───────────────────────────────────────────────────────────
//
// Slack does depend on whether the control is up: showing it consumes exactly
// its own width. So the two directions ask different questions — hide when the
// slack has gone negative, show only when there is the control's width *and* a
// margin to spare — and the gap between those two is what stops the row
// flickering at the width where the answer changes. See fitsInHeader.

// Enough that a control is only brought back with room to spare, and — since it
// is bigger than the gap either side of it — enough that the first thing a newly
// shown control does cannot be to take the slack below zero and hide itself
// again.
const CUSHION = 8;

const px = (v) => parseFloat(v) || 0;

/**
 * Spare pixels in a bar.
 *
 * @param el       the box whose children do not grow — a section's title button,
 *                 a floating window's header. Passing a box with a `flex: 1`
 *                 child other than the elastic one always reads zero, because
 *                 that child will have eaten the slack being asked about.
 * @param elastic  selector for the one child that gives way, measured by its
 *                 text rather than its box.
 * @returns        pixels left over; negative means the elastic child is being
 *                 truncated to make everything fit.
 */
export function measureSlack(el, elastic) {
    if (!el) return 0;
    const cs = getComputedStyle(el);
    const gap = px(cs.columnGap);
    const pad = px(cs.paddingLeft) + px(cs.paddingRight);

    let content = pad;
    let n = 0;
    for (const child of el.children) {
        n += 1;
        const flexible = child.matches && child.matches(elastic);
        content += flexible ? child.scrollWidth : child.offsetWidth;
    }
    content += gap * Math.max(0, n - 1);
    return el.clientWidth - content;
}

/**
 * Whether an optional control of `need` pixels belongs in the bar.
 *
 * @param slack  from measureSlack, with the control in whatever state it is in.
 * @param need   its width, including the gap it costs.
 * @param shown  whether it is up right now — which is what decides which of the
 *               two questions is being asked.
 */
export function fitsInHeader(slack, need, shown) {
    return shown ? slack >= 0 : slack >= need + CUSHION;
}
