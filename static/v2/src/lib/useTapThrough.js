// A control that can be tapped, on a surface that can be dragged.
//
// The drum is one big gesture: a press anywhere on it starts a spin, and it
// takes the pointer to do that. Anything drawn on top of it — the step buttons
// at the ends, the markers along the middle — has to answer a tap without
// taking that gesture away, because a control that swallowed the press would
// leave a dead patch on the thing you throw.
//
// So the press is *left to bubble*. The barrel captures the pointer, which
// means every move and release after that moment is delivered to the barrel and
// not to the control — the control cannot see how the gesture ended. What it
// can see is the window, which both halves pass through on their way up, so
// that is where this listens.
//
// The action is stored with the press rather than looked up on release. The
// marker under a thumb when it lands is the one a tap should step to, and the
// list underneath can change while a finger is down — a spot arriving, the dial
// moving the nearest marker along.
//
// Click is not used, for two reasons: the press has already been dealt with by
// then, and browsers disagree about whether a click arrives at all at an
// element whose pointer was captured by an ancestor mid-gesture. Keyboards are
// a separate matter — a control that wants to be operable from one should have
// its own onClick, which never comes from a pointer here.

import { useCallback, useEffect, useRef } from '../react.js';
import { isTap } from './barrel.js';

/**
 * Returns `press(event, action)`, to be called from onPointerDown.
 *
 * `action` runs on release, and only if the gesture turned out to be a tap
 * rather than the beginning of a spin — see isTap for where that line is.
 */
export default function useTapThrough() {
    const press = useRef(null);

    useEffect(() => {
        const stray = (e) => {
            const p = press.current;
            if (!p || e.pointerId !== p.id) return;
            // The furthest it has been, not where it is now: a flick that
            // returns to where it started is still a flick.
            p.dev = Math.max(p.dev, Math.abs(e.clientX - p.x), Math.abs(e.clientY - p.y));
        };
        const release = (e) => {
            const p = press.current;
            if (!p || e.pointerId !== p.id) return;
            press.current = null;
            if (isTap(p.dev, (e.timeStamp || performance.now()) - p.t)) p.act();
        };
        const drop = (e) => {
            const p = press.current;
            if (p && e.pointerId === p.id) press.current = null;
        };
        window.addEventListener('pointermove', stray);
        window.addEventListener('pointerup', release);
        window.addEventListener('pointercancel', drop);
        return () => {
            window.removeEventListener('pointermove', stray);
            window.removeEventListener('pointerup', release);
            window.removeEventListener('pointercancel', drop);
        };
    }, []);

    return useCallback((e, act) => {
        if (!act) return;
        press.current = {
            id: e.pointerId, x: e.clientX, y: e.clientY, dev: 0,
            t: e.timeStamp || performance.now(), act,
        };
    }, []);
}
