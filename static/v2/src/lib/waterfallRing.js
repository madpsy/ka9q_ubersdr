// Reading a waterfall's ring buffer in order.
//
// The waterfall keeps its history in an offscreen canvas used as a ring: the
// newest row is written at a decrementing index, so time runs *downward*
// through increasing indices and wraps at the end. See SpectrumView.jsx.
//
// Two places have to read that back in order, and they are the same read:
//
//   * painting the visible canvas — the whole ring, newest at the top;
//   * resizing the pane — the newest `rows` of it, into a new canvas.
//
// Both are "walk from the head, wrapping once", which is one or two contiguous
// runs. Getting the wrap wrong shows up as a waterfall that looks plausible but
// has a seam of older history spliced into the middle of it, so it lives here
// as a function that can be tested rather than as the same three lines of index
// arithmetic written out twice.

/** The background the ring is cleared to — nothing received yet. */
export const RING_BG = '#05070c';
/** The same colour as numbers, for anything mixing toward it — see lib/dss.js. */
export const RING_BG_RGB = [0x05, 0x07, 0x0c];

// Device pixels the waterfall canvas overhangs its container by, so the smooth
// scroll always has a row in hand to slide into view while its container clips
// the rest. The tallest a row can be is the Display panel's 4 CSS px at a
// device ratio of 2, so eight covers every case and costs eight rows of canvas.
export const RING_PAD = 8;

// Bounds on the estimated gap between rows, in ms. Below the floor there is
// nothing worth animating — the step is already at the display's own rate — and
// above the ceiling a feed that has stalled would otherwise leave the next row
// crawling into place for as long as the stall lasted.
export const SCROLL_MIN_MS = 25;
export const SCROLL_MAX_MS = 600;

// How much a sample may differ from the estimate, or from the sample before it,
// and still count as the same rate. Row commits are gated on an animation
// frame, so a steady 20 Hz feed arrives as an alternating 50 and 67 ms — a
// third either way — while the rate changes that matter here are the receiver
// sending half or twice as often, which is 100%.
export const JITTER_BAND = 0.35;

// Weight given to a new sample within the band. Low, because within the band
// the variation is noise and following it would make the slide duration swing
// by a third from row to row, which is itself visible as the scroll surging.
export const SAMPLE_WEIGHT = 0.3;

/**
 * The running estimate of how long the next row will take to arrive.
 *
 * Smooth scrolling means sliding a row into view over the gap until the next
 * one, and that gap is not known until it has passed — so it is predicted from
 * the ones before it. Two different things move that gap and they want opposite
 * treatment, which is the whole of this function:
 *
 *   * **Jitter** — the same rate, sampled against the animation clock. Damped,
 *     for the reason on SAMPLE_WEIGHT above.
 *   * **A change of rate** — the span changed and the receiver is now sending
 *     at a different rate entirely. Adopted at once, because until the estimate
 *     catches up every row slides for the wrong length of time.
 *
 * A plain average cannot tell them apart and treats both as jitter, which reads
 * as the waterfall going sluggish for a second and then settling — every time
 * the rate changes, which is every zoom. So a jump is seeded rather than
 * averaged in, but only once *two* arrivals agree: one sample that disagrees
 * with the estimate is a dropped frame, and following it would make the next
 * row slide at half speed and then jump when it was cut off. Two in a row that
 * agree with each other and not with the estimate is a rate that has genuinely
 * moved.
 *
 * `lastDt` is the previous raw gap — the caller keeps it, so this stays a
 * function of its arguments.
 */
export function smoothInterval(prev, dt, lastDt) {
    if (!(dt > 0)) return prev > 0 ? prev : 0;
    const clamp = (v) => Math.min(SCROLL_MAX_MS, Math.max(SCROLL_MIN_MS, v));
    const sample = clamp(dt);
    if (!(prev > 0)) return sample;

    // Clamped before comparison as well as before use: a stalled feed must not
    // be able to "agree" with itself at thirty seconds and drag the estimate
    // out to the ceiling.
    const previous = lastDt > 0 ? clamp(lastDt) : 0;
    const agree = previous > 0 && Math.abs(sample - previous) <= previous * JITTER_BAND;
    const stale = Math.abs(sample - prev) > prev * JITTER_BAND;
    if (agree && stale) return sample;

    return prev * (1 - SAMPLE_WEIGHT) + sample * SAMPLE_WEIGHT;
}

/**
 * The runs to copy, in destination order, as `[{ sy, sh, dy }]`.
 *
 * `head` is the index of the newest row and `height` the ring's size. `rows` is
 * how many of them are wanted, newest first — the full height when painting,
 * and the smaller of the two heights when resizing into a new ring.
 *
 * Rows beyond what is asked for are simply not returned: on a resize that is
 * the oldest history falling off the end, which is where it was going anyway.
 */
export function ringSlices(head, height, rows) {
    const h = Math.max(0, Math.floor(height));
    const want = Math.min(h, Math.max(0, Math.floor(rows)));
    if (!want) return [];
    const start = ((Math.floor(head) % h) + h) % h;

    // From the head to the end of the buffer, then — if that was not enough —
    // from the start of it. The second run can never overrun the head: it is
    // capped at `want - firstH`, and `want` is at most the whole ring.
    const firstH = Math.min(h - start, want);
    const runs = [{ sy: start, sh: firstH, dy: 0 }];
    if (firstH < want) runs.push({ sy: 0, sh: want - firstH, dy: firstH });
    return runs;
}

/**
 * Whether a resized pane can keep the history it already has.
 *
 * Height and width are not the same kind of change, but both are survivable.
 *
 * A row is a finished scanline: the pane's height decides only how many of them
 * fit, so a height change costs nothing and the rows are copied across as they
 * are. Every *column*, by contrast, is a frequency — the bins are collapsed onto
 * the pixel width as each row arrives — so at a new width the stored columns sit
 * under different frequencies than the new axis says. Copied over unchanged they
 * would draw signals where they never were.
 *
 * They are not copied unchanged. The mapping from frequency to x is linear in
 * the width, so the correction is a horizontal rescale of the bitmap — exactly
 * what a zoom already does to it (see panTransform, which returns a scale for
 * any span change and lets the caller resample once). A resize is the same
 * operation with the roles swapped: the span holds still and the width moves.
 *
 * So this now answers "is there a ring worth carrying over" and the caller does
 * the scaling. What it costs is one nearest-neighbour resample per width change:
 * discrete for a dock being toggled, and one per frame while a window edge is
 * dragged, which is where the quantisation accumulates. That is the trade — a
 * history that goes slightly steppy after a long drag, against one that was
 * thrown away every time the layout moved.
 */
export function ringKeepsHistory(prev, width) {
    return !!(prev && prev.ring && prev.height > 0 && prev.width > 0 && width > 0);
}

/**
 * Where the history has to move to when the view moves under it.
 *
 * The ring's pixels were painted against `ring` (the centre and span current
 * when they arrived); the axis now says `view`. This is the horizontal transform
 * that brings one onto the other, as a source-to-destination blit:
 *
 *   drawImage(ring, 0, 0, W, H, offset, 0, W * scale, H)
 *
 * `pureShift` is a pan — same span, so the copy is a translation and rounding it
 * to a whole pixel makes it lossless. That matters because a drag produces one
 * of these per frame, and resampling the same bitmap sixty times a second turns
 * a week of history into porridge. The rounding error comes back as `centre`,
 * the frequency the pixels are *actually* on afterwards, so the next call
 * carries it rather than dropping it and the picture cannot drift.
 *
 * `drop` means the two views do not overlap at all — a band change rather than a
 * pan — and there is nothing worth carrying over.
 */
export function panTransform(ring, view, width) {
    if (!ring || !view || !(view.span > 0) || !(ring.span > 0) || !(width > 0)) return null;
    if (ring.centre === view.centre && ring.span === view.span) return null;

    const scale = ring.span / view.span;
    const oldStart = ring.centre - ring.span / 2;
    const newStart = view.centre - view.span / 2;
    const pureShift = Math.abs(scale - 1) < 1e-9;

    let offset = ((oldStart - newStart) / view.span) * width;
    if (pureShift) {
        offset = Math.round(offset);
        // Less than half a pixel: leave the bitmap alone *and* leave the
        // recorded view where it is, so the debt goes on growing and the next
        // frame of the same drag can settle it. Recording the live centre here
        // instead would zero the debt every frame, and a slow drag would move
        // the history not by a pixel at a time but never at all.
        if (offset === 0) {
            return {
                offset: 0, scale: 1, pureShift: true, drop: false, still: true,
                centre: ring.centre, span: ring.span,
            };
        }
    }

    const kept = width * scale;
    if (offset >= width || offset + kept <= 0) {
        return { offset, scale, pureShift, drop: true, still: false, centre: view.centre, span: view.span };
    }

    return {
        offset,
        scale,
        pureShift,
        drop: false,
        still: false,
        // Where the pixels end up, which for a pan is the rounded offset rather
        // than where they were asked to go.
        centre: pureShift ? (oldStart - (offset * view.span) / width) + view.span / 2 : view.centre,
        span: pureShift ? ring.span : view.span,
    };
}
