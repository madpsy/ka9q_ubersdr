// The React around lib/headerRoom.js: when to measure, and remembering which of
// the two questions to ask.
//
// The state is the answer *and* an input to the next measurement — that is what
// the hysteresis in fitsInHeader is — so it is read through a ref rather than
// closed over, and the observer watches the bar rather than the window: a dock
// dragged wider resizes the header with nothing re-rendering at all.

import { useCallback, useLayoutEffect, useRef, useState } from '../react.js';
import { fitsInHeader, measureSlack } from './headerRoom.js';

export function useHeaderFits(ref, elastic, need) {
    // Shown to begin with: an element that has not been laid out yet measures
    // zero, and a control that blinked in on the second frame is worse than one
    // that blinks out.
    const [fits, setFits] = useState(true);
    const shown = useRef(true);
    shown.current = fits;

    // What the control *actually* costs, once that has been observed.
    //
    // `need` is a constant the caller wrote down, and the hysteresis in
    // fitsInHeader is only sound while it is true: show at `need + CUSHION` of
    // slack, keep while slack is not negative. Let the real control be wider
    // than the number and the two rules disagree for ever — there is room to
    // show it, showing it overflows, so it goes, and now there is room again.
    // That is a render loop rather than a flicker, and React ends it by
    // throwing (#185), which blanks the whole interface.
    //
    // It stopped being true when the buttons in these bars grew for touch. The
    // answer is not a bigger constant — the next change of padding would put it
    // back — but to measure: the difference between the slack with the control
    // down and the slack with it up *is* what it costs, gap included. One flip
    // teaches it exactly, which is why both are remembered.
    //
    // Inferring it from the overflow alone was the first attempt and is not
    // enough: a control that overruns by a pixel raises the estimate by a
    // pixel, so a bar that is a hair too small takes dozens of flips to settle
    // — and React stops at fifty.
    const real = useRef(need);
    if (real.current < need) real.current = need;
    const slackWhenHidden = useRef(null);

    // ...and a floor under it all, for a case this cannot reason about: two
    // controls in one bar whose widths depend on each other, a font that loads
    // late, a browser that rounds differently in each state. Whatever the
    // cause, a bar that has changed its mind this many times is not converging,
    // and the honest end is to leave the control out. Cleared by a real resize,
    // which is a new question rather than the same one again.
    const flips = useRef(0);

    const measure = useCallback(() => {
        const el = ref.current;
        if (!el || !el.clientWidth) return;
        const slack = measureSlack(el, elastic);

        if (shown.current) {
            if (slack < 0 && slackWhenHidden.current != null) {
                real.current = Math.max(real.current, slackWhenHidden.current - slack);
            }
        } else {
            slackWhenHidden.current = slack;
        }

        const next = flips.current > 4 ? false : fitsInHeader(slack, real.current, shown.current);
        setFits((prev) => {
            if (prev === next) return prev;
            flips.current += 1;
            return next;
        });
    }, [ref, elastic, need]);

    // No dependency list, as useRoomFor: a title can change under a bar that has
    // not moved — a badge appears, a panel is renamed — and the answer with it.
    useLayoutEffect(measure);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(() => {
            // A different bar is a different question: whatever it decided at
            // the old size says nothing about this one.
            flips.current = 0;
            measure();
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, [ref, measure]);

    return fits;
}
