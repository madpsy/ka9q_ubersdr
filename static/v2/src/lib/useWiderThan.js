// Is this box at least so many pixels across?
//
// For chrome that is worth having in a panel wide enough for it and is the first
// thing to go in one that is not — the per-panel zoom pair, at the time of
// writing. useRoomFor answers a better question than this one, by measuring what
// is actually in the row, and it cannot be used here: it requires every
// non-optional child of the row to be the width it says it is, and a panel
// header's title is an ellipsis that shrinks with the header. Summing that gives
// a figure that falls in step with the panel, so nothing is ever judged not to
// fit — and the header would happily draw its buttons on top of the title.
//
// So the question is asked of the panel instead of the header, and that is what
// makes the answer hold still: a panel's width comes from the dock it is in, the
// window geometry, or the screen. None of those move when a button inside the
// header appears or disappears, so there is no loop to fall into — which is not
// true of anything measured inside the header itself.

import { useCallback, useLayoutEffect, useRef, useState } from '../react.js';

export function useWiderThan(ref, px) {
    const [wide, setWide] = useState(true);
    // Read by the measurement without re-creating the observer when it changes.
    const at = useRef(px);
    at.current = px;

    const measure = useCallback(() => {
        const el = ref.current;
        if (!el) return;
        const w = el.clientWidth;
        // A box that has not been laid out yet reports zero, which is not an
        // answer — assume there is room rather than blinking the controls in.
        setWide(w ? w >= at.current : true);
    }, [ref]);

    useLayoutEffect(measure);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [ref, measure]);

    return wide;
}
