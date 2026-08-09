// Type that shrinks to keep a readout whole, rather than dropping part of it.
//
// The top bar's tuning readout is three things — the frequency, the mode, the
// filter width — and on a handset the row is not wide enough for all three at
// full size. useRoomFor's answer to that is to drop the last of them, which is
// the right answer for a countdown or a space weather block and the wrong one
// here: the filter width is what you are listening *through*, and a receiver
// that hides it has hidden a number you cannot get back without opening a panel.
//
// So the readout gives up size before it gives up content. This works out how
// much: one factor, applied to the three font sizes, that makes the whole thing
// fit the room the rest of the bar leaves it. Below `min` it stops asking and
// useRoomFor takes over again — type small enough to keep a number is worth it,
// type too small to read is not.
//
// ── Holding still ───────────────────────────────────────────────────────────
//
// The same trap roomFor.js is written around, and worse here: a measurement
// that decides a size, applied to the thing measured, is a loop by construction.
// Two rules keep it out.
//
// The first is what is measured. Never the readout as it stands — always the
// row's *other* children, whose widths do not move when the readout's type does.
// What is left over is the readout's budget, and that figure is the same at
// every scale.
//
// The second is what the readout is said to need. Its text is measured at the
// scale it is currently drawn at and divided back out, which recovers the width
// at scale 1 — an invariant, whatever it is drawn at now. And the parts are
// remembered by name, so a filter width that useRoomFor has already dropped
// still counts towards the figure: the scale that is being solved for is the one
// that would fit the *whole* readout, which is the only question worth asking.
// Without that the two would fight — the chip goes, the readout has room, the
// type grows, the chip comes back, and it no longer fits.
//
// The result is quantised to `step`, so the last pixel of a resize does not
// leave the type twitching between two sizes a fraction of each other.

// The floor — and note what happens *below* it: the type goes back to full size
// rather than stopping here. Shrinking is only ever worth doing if it buys the
// filter width, so a row so narrow that even this will not fit it should have
// the readout it would have had anyway, with useRoomFor dropping the chip as it
// always did. Small type and no filter width is the one outcome worse than
// either, and clamping to the floor is how you get it.
//
// Just under three-quarters puts the compact bar's 14px frequency at about ten,
// which is the size of the tags under the spectrum: small, still a readout, and
// the point past which it stops being the thing your eye goes to in the bar.
export const FIT_MIN = 0.72;

// Coarse on purpose — see the note about quantising above. Four points of scale
// on a 14px readout is about half a pixel, which is below the size at which a
// change of type size reads as a change at all.
export const FIT_STEP = 0.04;

// The same margin roomFor keeps, and for the same reason: a readout grown into
// the last pixel of the row is one that will be squeezed by the first thing that
// gets a character wider.
const CUSHION = 8;

const px = (v) => parseFloat(v) || 0;

/**
 * The scale the readout should be drawn at.
 *
 * @param row    the flex row it sits in.
 * @param el     the readout. Its scalable parts carry `data-fit="<key>"`; the
 *               rest of it — padding, border, the gaps between those parts — is
 *               taken as fixed, because it is.
 * @param scale  what it is drawn at now, which is what the measurement is
 *               divided back out by.
 * @param widths the per-part width cache, `{ key: widthAtScale1 }`, read and
 *               written. Held across renders by the caller, so a part that is
 *               not on screen right now still counts for what it would cost.
 * @returns      a number in [min, 1].
 */
export function measureFit(row, el, scale, widths, opts = {}) {
    const min = opts.min != null ? opts.min : FIT_MIN;
    const step = opts.step != null ? opts.step : FIT_STEP;
    if (!row || !el) return 1;

    const cs = getComputedStyle(row);
    const gap = px(cs.columnGap);
    const pad = px(cs.paddingLeft) + px(cs.paddingRight);

    // Everything in the row but the readout. A spacer is room rather than
    // content — the same rule roomFor follows — but it is still a box the gaps
    // are counted between, which is why it is skipped after being counted.
    let others = 0;
    let count = 0;
    for (const child of row.children) {
        count += 1;
        if (child === el) continue;
        if (child.dataset.slack != null) continue;
        others += child.offsetWidth;
    }
    const avail = row.clientWidth - pad - others - gap * Math.max(0, count - 1) - CUSHION;

    // What the parts cost at scale 1. Measured where they are on screen, and
    // remembered where they are not.
    const inner = px(getComputedStyle(el).columnGap);
    const parts = el.querySelectorAll('[data-fit]');
    let live = 0;
    for (const p of parts) {
        live += p.offsetWidth;
        widths[p.dataset.fit] = p.offsetWidth / (scale || 1);
    }
    const keys = Object.keys(widths);
    if (!keys.length) return 1;
    let text = 0;
    for (const k of keys) text += widths[k];
    if (text <= 0) return 1;

    // The readout's own box, less the parts inside it: padding, border, and the
    // gaps between however many parts there *are* — not however many are drawn,
    // since `text` is the price of all of them.
    const box = el.offsetWidth - live - inner * Math.max(0, parts.length - 1);
    const room = avail - box - inner * Math.max(0, keys.length - 1);

    // Floored rather than rounded, in both directions: the type only grows a
    // step when there is a whole step of room for it, which is the half of the
    // hysteresis that measurement noise could otherwise flip.
    const want = Math.floor((room / text) / step) * step;
    // Out of the question, so do not ask — see FIT_MIN. This is a function of the
    // row's width and nothing else, which is what keeps it from flip-flopping
    // with the chip it is trying to save.
    if (want < min) return 1;
    return Math.min(1, want);
}
