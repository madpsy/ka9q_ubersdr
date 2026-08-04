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
 * Height and width are not the same kind of change. Every column of the ring is
 * a frequency — the bins are collapsed onto the pixel width — so at a new width
 * the stored columns mean something other than what the new axis says, and
 * carrying them over would draw signals where they never were. A row, by
 * contrast, is a finished scanline: the pane's height decides only how many of
 * them fit, and none of them becomes wrong when it changes.
 */
export function ringKeepsHistory(prev, width) {
    return !!(prev && prev.ring && prev.height > 0 && prev.width === width);
}
