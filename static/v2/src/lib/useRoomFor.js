// Does a flex row still have room for one optional child?
//
// For readouts that are worth showing when the window is wide and are the first
// thing that should go when it is not — the cursor frequency in the spectrum
// toolbar, the session countdown in the top bar. Dropping them beats letting
// them squeeze or wrap the row they are in.
//
// The answer is worked out from the row's *other* children, never from the row
// as it stands, and that is the whole trick: measure the row with the optional
// child in it and hiding the child frees exactly the space that then says it
// fits, so it blinks on and off once a render. Summing everything else is a
// figure that does not move when the child comes and goes.
//
// Children are marked with data attributes:
//
//   data-optional   the child in question. Measured whenever it is up, and its
//                   last width is remembered for while it is not.
//   data-slack      a flex spacer. Skipped — it is room, not content, and its
//                   width is whatever is left over, which would otherwise make
//                   every row look exactly full.
//
// `fallbackW` stands in until the child has been on screen once to measure.

import { useCallback, useLayoutEffect, useRef, useState } from '../react.js';

// Kept in hand so the child is only shown with room to spare. Without it a row
// whose other children can shrink — a top bar with a truncating name in it —
// takes the last few pixels for the optional child and squeezes them instead.
const CUSHION = 8;

export function useRoomFor(rowRef, fallbackW) {
    const lastW = useRef(0);
    const [fits, setFits] = useState(true);

    const measure = useCallback(() => {
        const el = rowRef.current;
        if (!el) return;
        const cs = getComputedStyle(el);
        const gap = parseFloat(cs.columnGap) || 0;
        const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
        let need = 0;
        for (const child of el.children) {
            if (child.dataset.slack != null) continue;
            if (child.dataset.optional != null) { lastW.current = child.offsetWidth; continue; }
            // One gap per counted child: n of them plus the optional one needs
            // exactly n gaps between the n+1 items.
            need += child.offsetWidth + gap;
        }
        setFits(need + (lastW.current || fallbackW) + CUSHION <= el.clientWidth - pad);
    }, [rowRef, fallbackW]);

    // Deliberately no dependency list: children of these rows appear and vanish
    // on their own (a squelch tag, a space weather block) without the row's own
    // width changing, so every render is a chance the answer moved.
    useLayoutEffect(measure);

    // ...and the row can be resized with nothing re-rendering at all.
    useLayoutEffect(() => {
        const el = rowRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [rowRef, measure]);

    return fits;
}
