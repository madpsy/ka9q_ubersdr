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

// How close together two changes of mind have to be to count as thrash.
const SETTLE_MS = 400;

export function useRoomFor(rowRef, specs) {
    // Last measured width per key, so a child that is hidden right now still
    // asks for the space it actually had rather than its rough fallback.
    const widths = useRef({});
    // Read inside measure without being a dependency of it: callers build this
    // array inline, and a fresh array every render would rebuild the observer.
    const specsRef = useRef(specs);
    specsRef.current = specs;
    const [fits, setFits] = useState(() => Object.fromEntries(specs.map((s) => [s.key, true])));
    // What is up right now, for the hysteresis in measureRoom — read there, so
    // it has to be the *current* answer rather than the one this render closed
    // over.
    const shown = useRef(fits);
    shown.current = fits;

    // How many times this row has changed its mind in quick succession.
    //
    // The hysteresis below should make that a small number, and if it is not
    // then something is oscillating this cannot reason about: two children
    // whose widths depend on each other, a font arriving late, a row whose own
    // width follows its contents. Whatever the cause, the row settles for
    // showing less rather than letting React give up — a blank interface is
    // the one outcome worse than a missing tag.
    //
    // Counted within a *window* rather than reset by a resize, which was the
    // first attempt and is worse than useless: this row's width can itself
    // change when a child is dropped, so the observer fired on every lap and
    // cleared the counter each time. Thrash happens inside a frame or two; a
    // genuine change of circumstance is further apart than this.
    const flips = useRef(0);
    const flipAt = useRef(0);

    const measure = useCallback(() => {
        const el = rowRef.current;
        if (!el) return;
        const now = Date.now();
        if (now - flipAt.current > SETTLE_MS) flips.current = 0;
        const next = flips.current > 4
            ? Object.fromEntries(specsRef.current.map((s) => [s.key, false]))
            : measureRoom(el, specsRef.current, widths.current, shown.current);

        // Nothing moved: return without touching the setter at all.
        //
        // Not "set it and let React notice it is the same value", which is what
        // this did and is a render loop waiting for a busy moment. This runs
        // after *every* render, so on a bar that renders often it calls the
        // setter dozens of times a second. React usually discards a set that
        // computes to the value already held — but only while that component
        // has no other update pending. When one is in flight it cannot know the
        // result in advance, so it schedules a re-render, which runs this
        // effect, which schedules another; fifty deep React gives up and throws
        // (#185), taking the whole interface down with it. A receiver has
        // something arriving on nearly every frame, so the busy moment is all
        // the time.
        if (sameFits(shown.current, next)) return;
        // Read by the *next* call, which may come before React has re-rendered.
        shown.current = next;
        flips.current += 1;
        flipAt.current = now;
        setFits(next);
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
