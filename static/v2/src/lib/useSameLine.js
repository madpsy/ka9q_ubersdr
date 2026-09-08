// Which items in a wrapping row start a new line?
//
// One question, for one job: separators that only mean anything inline. A
// middot between "2h ago" and a frequency, or between a continent and its CQ
// zone, reads as a separator while the two are side by side and as a dangling
// piece of punctuation the moment the second drops to a line of its own — which
// in a 220 px side dock is most of the time.
//
// Returns one boolean per item: true where that item begins a line and the
// separator in front of it therefore has nothing left to separate. The first
// item is always true, and so is everything, until the row has been laid out
// and measured.
//
// ── The rule a caller has to keep ───────────────────────────────────────────
//
// Whatever this answer switches MUST NOT change the layout it was measured
// from. Hide a separator that occupies space and the row gets narrower, which
// may un-wrap it, which brings the separator back, which wraps it again — and
// React ends that at fifty renders by throwing #185, which blanks the whole
// interface. lib/useHeaderFits.js is the same measurement made where the
// feedback is real, and the hysteresis, the flip counter and the settle window
// in it are all there to survive that loop.
//
// There is none of that here because there is no loop to survive: the caller
// draws each separator as an absolutely positioned pseudo-element hanging in a
// column gap that is there whether or not it is filled, so hiding one moves
// nothing. Any other caller has to arrange the same thing, or use the hook that
// does the hard version.

import { useCallback, useLayoutEffect, useRef, useState } from '../react.js';

/**
 * @param boxRef   the wrapping row
 * @param itemsRef a ref holding the item elements, in order — a plain array, so
 *                 a caller can fill it from a ref callback without re-rendering
 * @param count    how many items there are, so the effect re-runs when the row
 *                 gains or loses one
 */
export function useSameLine(boxRef, itemsRef, count) {
    const [starts, setStarts] = useState(() => []);
    const now = useRef(starts);
    now.current = starts;

    const measure = useCallback(() => {
        const items = itemsRef.current || [];
        // offsetTop rather than a rect: the items are the same box in different
        // places, so the only thing being asked is whether two share a line box,
        // and an integer comparison cannot answer that half a pixel wrong.
        const next = items.map((el, i) => {
            if (i === 0) return true;
            const prev = items[i - 1];
            return !el || !prev || el.offsetTop !== prev.offsetTop;
        });
        const was = now.current;
        // Unchanged: don't call the setter. Setting a value React already holds,
        // from an effect that runs after every render, is a render loop by
        // itself — see the note in useRoomFor.
        if (was.length === next.length && next.every((v, i) => v === was[i])) return;
        now.current = next;
        setStarts(next);
    }, [itemsRef]);

    // No dependency list: the text can change under a row that has not moved —
    // a new spot arrives, an age ticks from 59m to 1h — and the answer with it.
    useLayoutEffect(measure);

    useLayoutEffect(() => {
        if (typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(measure);
        // The box, because a dock dragged narrower re-wraps its contents without
        // any of them changing size; and each item, because a late web font
        // changes their width without the box moving at all.
        if (boxRef.current) ro.observe(boxRef.current);
        for (const el of itemsRef.current || []) if (el) ro.observe(el);
        return () => ro.disconnect();
    }, [boxRef, itemsRef, measure, count]);

    return starts;
}
