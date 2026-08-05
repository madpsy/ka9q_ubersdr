// Which of a flex row's optional children still fit?
//
// For readouts that are worth showing when the window is wide and are the first
// thing that should go when it is not — the cursor frequency in the spectrum
// toolbar, the space weather block and the session countdown in the top bar.
// Dropping them beats letting them squeeze or wrap the row they are in.
//
// The answer is worked out from the row's *other* children, never from the row
// as it stands, and that is the whole trick: measure the row with an optional
// child in it and hiding the child frees exactly the space that then says it
// fits, so it blinks on and off once a render. Summing everything else is a
// figure that does not move when the child comes and goes.
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
// `specs` is [{ key, width }] in *keep* order: most important first, so the
// last one is the first to go as the row narrows. `width` stands in until that
// child has been on screen once to be measured. Returns { key: boolean }.
//
// Priority is what makes this worth generalising past one child. Summing every
// optional child and showing them all or none would drop the countdown to make
// room for a space weather block nobody asked to keep.

import { useCallback, useLayoutEffect, useRef, useState } from '../react.js';

// Kept in hand so a child is only shown with room to spare. Without it a row
// whose other children can shrink — a top bar with a truncating name in it —
// takes the last few pixels for the optional child and squeezes them instead.
const CUSHION = 8;

const same = (a, b) => {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
};

export function useRoomFor(rowRef, specs) {
    // Last measured width per key, so a child that is hidden right now still
    // asks for the space it actually had rather than its rough fallback.
    const lastW = useRef({});
    // Read inside measure without being a dependency of it: callers build this
    // array inline, and a fresh array every render would rebuild the observer.
    const specsRef = useRef(specs);
    specsRef.current = specs;
    const [fits, setFits] = useState(() => Object.fromEntries(specs.map((s) => [s.key, true])));

    const measure = useCallback(() => {
        const el = rowRef.current;
        if (!el) return;
        const cs = getComputedStyle(el);
        const gap = parseFloat(cs.columnGap) || 0;
        const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);

        let used = 0;
        let count = 0;
        for (const child of el.children) {
            if (child.dataset.slack != null) continue;
            if (child.dataset.optional != null) {
                lastW.current[child.dataset.optional] = child.offsetWidth;
                continue;
            }
            used += child.offsetWidth;
            count += 1;
        }

        const avail = el.clientWidth - pad;
        const next = {};
        for (const s of specsRef.current) {
            const w = lastW.current[s.key] || s.width;
            // n items already placed, plus this one, needs n gaps between them.
            if (used + w + gap * count + CUSHION <= avail) {
                next[s.key] = true;
                used += w;
                count += 1;
            } else {
                next[s.key] = false;
            }
        }
        // Same answer, same object: this runs after every render, and a fresh
        // object each time would be a render loop.
        setFits((prev) => (same(prev, next) ? prev : next));
    }, [rowRef]);

    // Deliberately no dependency list: children of these rows appear and vanish
    // on their own (a squelch tag, a noise reduction tag) without the row's own
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
