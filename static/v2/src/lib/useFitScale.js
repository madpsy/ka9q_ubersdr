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

// How close together two changes of size have to be to count as thrash.
const SETTLE_MS = 400;

const same = (a, b) => Math.abs(a - b) < 1e-6;

export function useFitScale(rowRef, elRef, on) {
    const widths = useRef({});
    const [scale, setScale] = useState(1);
    // Read by the measurement without making it a dependency: the scale it is
    // dividing out is the one on screen, and re-creating the observer every time
    // that changed would be a resize observer per step.
    const scaleRef = useRef(1);
    scaleRef.current = scale;

    // How many times the readout has changed size in quick succession, and the
    // size it is not allowed to grow past once that has gone on too long.
    //
    // The measurement divides the drawn width back out by the scale it was drawn
    // at, and that division is not quite exact: text is laid out on whole device
    // pixels and hinted per size, so the same string measured at 0.85 and at 0.9
    // does not agree to the pixel about what it costs at 1. Nearly always the
    // step floor absorbs that. Where it does not, two sizes each say the other
    // is right — the readout shrinks, which says there is room to grow, which
    // says shrink — and because this measures after every render that argument
    // runs flat out until React stops it by throwing (#185), which blanks the
    // interface rather than wobbling a font size.
    //
    // So: a bar that has changed its mind this often settles for the smaller of
    // the two and stops growing. Smaller is the safe end — it is the size that
    // was observed to fit — and the ceiling only lasts as long as the thrash,
    // so a genuine resize a moment later is measured afresh.
    const flips = useRef(0);
    const flipAt = useRef(0);
    const ceiling = useRef(0);

    const measure = useCallback(() => {
        if (!on) return;
        const now = Date.now();
        if (now - flipAt.current > SETTLE_MS) { flips.current = 0; ceiling.current = 0; }

        let next = measureFit(rowRef.current, elRef.current, scaleRef.current, widths.current);
        if (ceiling.current) next = Math.min(next, ceiling.current);
        // Nothing moved: return without touching the setter at all. Not "set it
        // and let React notice it is the same value" — this runs after every
        // render, and a set React cannot discard (which is any set made while
        // that component has another update in flight) schedules a re-render,
        // which runs this, which sets again. See useRoomFor.
        if (same(scaleRef.current, next)) return;

        flips.current += 1;
        flipAt.current = now;
        if (flips.current > 4) {
            next = Math.min(next, scaleRef.current);
            ceiling.current = next;
            if (same(scaleRef.current, next)) return;
        }
        // Read by the next call, which may come before React has re-rendered.
        scaleRef.current = next;
        setScale(next);
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
            flips.current = 0;
            ceiling.current = 0;
            if (!same(scaleRef.current, 1)) {
                scaleRef.current = 1;
                setScale(1);
            }
        }
    }, [on]);

    return on ? scale : 1;
}
