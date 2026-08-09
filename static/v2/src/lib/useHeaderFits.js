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

    const measure = useCallback(() => {
        const el = ref.current;
        if (!el || !el.clientWidth) return;
        const next = fitsInHeader(measureSlack(el, elastic), need, shown.current);
        setFits((prev) => (prev === next ? prev : next));
    }, [ref, elastic, need]);

    // No dependency list, as useRoomFor: a title can change under a bar that has
    // not moved — a badge appears, a panel is renamed — and the answer with it.
    useLayoutEffect(measure);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [ref, measure]);

    return fits;
}
