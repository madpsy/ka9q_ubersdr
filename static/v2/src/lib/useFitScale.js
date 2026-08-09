// The React around lib/fitScale.js: when to measure, and holding the part
// widths across renders. useRoomFor.js is the same shape for the same reasons.
//
// `on` is what turns it off, and it is a prop rather than a check in here
// because only one row wants this. The desktop top bar must not: it has optional
// children of its own that come and go with the width, so a readout that shrank
// would free room for a clock, which would take the room back, which would
// shrink the readout again. On a phone the row is the readout and a handful of
// icon buttons, none of them optional, so there is nothing to fight with.

import { useCallback, useLayoutEffect, useRef, useState } from '../react.js';
import { measureFit } from './fitScale.js';

export function useFitScale(rowRef, elRef, on) {
    const widths = useRef({});
    const [scale, setScale] = useState(1);
    // Read by the measurement without making it a dependency: the scale it is
    // dividing out is the one on screen, and re-creating the observer every time
    // that changed would be a resize observer per step.
    const scaleRef = useRef(1);
    scaleRef.current = scale;

    const measure = useCallback(() => {
        if (!on) return;
        const next = measureFit(rowRef.current, elRef.current, scaleRef.current, widths.current);
        setScale((prev) => (Math.abs(prev - next) < 1e-6 ? prev : next));
    }, [rowRef, elRef, on]);

    // No dependency list, as useRoomFor: the readout's own text changes width as
    // the dial is turned — 7.100.000 is not 14.074.000 — with nothing about the
    // row itself having moved.
    useLayoutEffect(measure);

    useLayoutEffect(() => {
        const el = rowRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [rowRef, measure]);

    // Off means off, not "stuck at whatever it last was".
    useLayoutEffect(() => {
        if (!on) {
            widths.current = {};
            setScale(1);
        }
    }, [on]);

    return on ? scale : 1;
}
