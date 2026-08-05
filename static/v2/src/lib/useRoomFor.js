// Which of a flex row's optional children still fit?
//
// For readouts that are worth showing when the window is wide and are the first
// thing that should go when it is not — the cursor frequency in the spectrum
// toolbar, the filter width in the top bar, the space weather block and the
// session countdown. Dropping them beats letting them squeeze or wrap the row.
//
// The measuring is roomFor.js, which is where the reasoning lives and where the
// tests are. This is the React around it: when to measure, and holding the
// widths across renders.
//
// Priority is what makes this worth generalising past one child. Summing every
// optional child and showing them all or none would drop the countdown to make
// room for a space weather block nobody asked to keep.

import { useCallback, useLayoutEffect, useRef, useState } from '../react.js';
import { measureRoom, sameFits } from './roomFor.js';

export function useRoomFor(rowRef, specs) {
    // Last measured width per key, so a child that is hidden right now still
    // asks for the space it actually had rather than its rough fallback.
    const widths = useRef({});
    // Read inside measure without being a dependency of it: callers build this
    // array inline, and a fresh array every render would rebuild the observer.
    const specsRef = useRef(specs);
    specsRef.current = specs;
    const [fits, setFits] = useState(() => Object.fromEntries(specs.map((s) => [s.key, true])));

    const measure = useCallback(() => {
        const el = rowRef.current;
        if (!el) return;
        const next = measureRoom(el, specsRef.current, widths.current);
        // Same answer, same object: this runs after every render, and a fresh
        // object each time would be a render loop.
        setFits((prev) => (sameFits(prev, next) ? prev : next));
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
