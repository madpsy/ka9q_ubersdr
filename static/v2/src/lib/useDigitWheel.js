// Scroll over a digit to step the frequency by that digit's place value.
//
// The Receiver panel's dial has worked this way since it was written, and it is
// the quickest tuning gesture in the interface: no step size to pick first, no
// menu — put the pointer on the hundreds and turn the wheel. The top bar's
// readout now offers the same thing, which is what this file is for. Two copies
// of it would have been two chances to get the details below wrong.
//
// The caller marks its digits with `data-place="<hertz>"`; anything else in the
// element — separators, units, the space around them — is ignored, so a scroll
// that lands between digits does nothing rather than guessing.

import { useEffect, useRef } from '../react.js';
import { createWheelStep } from './wheelStep.js';

// A gesture ends after this long without a notch, so the next one reads the
// digit under the pointer afresh.
const GESTURE_MS = 600;

// The pointer counts as having stayed put within this many pixels. Two rather
// than zero only for safety: a wheel or a two-finger scroll moves the cursor
// not at all, so the events of one gesture carry identical coordinates. Well
// under the width of a digit, which is what stops it holding on to the old
// place when the pointer is deliberately moved to the next one.
const SAME_PX = 2;

/**
 * @param rootRef  the element containing the digits.
 * @param onStep   (place, dir) — dir is +1 up, -1 down, once per detent.
 * @param disabled ignore the wheel entirely.
 * @param rebind   changes when `rootRef` will point at a different element, so
 *                 the listener follows it. A readout that swaps itself for a
 *                 type-in box and back mounts a new node the second time, and
 *                 an effect with nothing to notice that would leave the gesture
 *                 working until the first time somebody typed a frequency and
 *                 dead afterwards. Both callers do exactly that.
 *
 * Two more details it exists to hold in one place:
 *
 *   A native listener, registered non-passive. React's onWheel is passive, so
 *   preventDefault() there is ignored and the dock behind the readout scrolls
 *   along with the digit being tuned.
 *
 *   The place is latched for the length of a gesture. The top bar's readout has
 *   no leading zeros, so tuning the megahertz digit from 9 to 10 gives the
 *   number another digit and everything under the pointer shifts along — and
 *   the next notch of the same gesture would then be worth ten times what the
 *   one before it was. Latching means one gesture steps one place, whatever the
 *   readout does underneath it. The dial, being eight digits wide whatever the
 *   frequency, never sees this; it costs nothing there.
 */
export default function useDigitWheel(rootRef, onStep, { disabled = false, rebind = 0 } = {}) {
    // Through a ref so a caller need not memoise its handler to keep the
    // listener — and so the accumulator inside is not thrown away and rebuilt
    // mid-scroll when the caller re-renders, which would drop a part-finished
    // notch on every step of a trackpad swipe.
    const stepRef = useRef(onStep);
    stepRef.current = onStep;

    useEffect(() => {
        const el = rootRef.current;
        if (!el) return undefined;
        const notch = createWheelStep();
        let held = null;

        const onWheel = (e) => {
            if (disabled) return;
            const cell = e.target.closest && e.target.closest('[data-place]');
            if (!cell) return;
            e.preventDefault();

            const now = performance.now();
            const same = held
                && now - held.at < GESTURE_MS
                && Math.abs(e.clientX - held.x) <= SAME_PX
                && Math.abs(e.clientY - held.y) <= SAME_PX;
            const place = same ? held.place : Number(cell.dataset.place);
            held = { place, x: e.clientX, y: e.clientY, at: now };

            // After the latch, not before: an event too small to be a notch is
            // still part of the gesture, and letting it keep the timestamp fresh
            // is what stops a slow trackpad scroll being read as a new one.
            const dir = notch(e);
            if (dir && place > 0) stepRef.current(place, dir);
        };

        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [rootRef, disabled, rebind]);
}
