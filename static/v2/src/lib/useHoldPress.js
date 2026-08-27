// "Right-click, or hold on a touchscreen" as one gesture.
//
// The secondary press on a button that already does something — the way to give
// a control a second job without a second button, which is what a 220 px dock
// header and a phone-width pad both need. PanelZoom uses it to get back to the
// global size; the Multipad's squelch Auto uses it to turn the squelch off.
//
// Three details it exists to stop each caller getting wrong on its own:
//
//   * The hold is touch only. A mouse has the right button for this, and a mouse
//     held still on a button is somebody reading the tooltip.
//   * `contextmenu` covers both the mouse's right button and, on Android, the
//     long press — which arrives there *as well as* through the timer. Harmless
//     where the action is idempotent, which is the only kind of action this is
//     for.
//   * A touch dispatches its compatibility click well after the timer has fired,
//     so there is nothing left to cancel by then. It is ignored on arrival
//     instead — see `afterHold`.

import { useCallback, useEffect, useRef } from '../react.js';

// Long enough not to fire on a firm tap, short enough to find by accident. One
// hold length across the app is one thing to learn: this is the figure
// Minesweeper's flag press and the panel zoom's reset were both already using,
// and the zoom now takes it from here.
export const HOLD_MS = 450;

// A click that lands within this of a hold is the tail of the gesture that did
// it, not a press of its own. A timestamp rather than a flag, as the top bar's
// menu buttons do it: a flag has to be cleared by an event that may never come —
// a right-click fires no click at all — and one left set would swallow the next
// real press instead.
const AFTER_HOLD_MS = 400;

/**
 * @param action  what the secondary press does. Called at most once per gesture
 *                by the timer, and again by `contextmenu` where the platform
 *                sends both — so it has to be idempotent. Given the element the
 *                press landed on, for the callers that open something *at* the
 *                button: the timer fires long after the event that started it,
 *                so the element is kept rather than the event.
 * @returns [press, afterHold]
 *          `press`      spread onto the element
 *          `afterHold`  true while the click a hold left behind is still
 *                       arriving; the element's own onClick should return early
 */
export default function useHoldPress(action) {
    const timer = useRef(null);
    const firedAt = useRef(0);
    const on = useRef(null);
    useEffect(() => () => clearTimeout(timer.current), []);

    const fire = useCallback(() => {
        firedAt.current = performance.now();
        action(on.current);
    }, [action]);

    const end = useCallback(() => clearTimeout(timer.current), []);

    const press = {
        onPointerDown: (e) => {
            if (e.pointerType === 'mouse') return;
            on.current = e.currentTarget;
            clearTimeout(timer.current);
            timer.current = setTimeout(fire, HOLD_MS);
        },
        onPointerUp: end,
        onPointerCancel: end,
        onPointerLeave: end,
        onContextMenu: (e) => {
            e.preventDefault();
            on.current = e.currentTarget;
            fire();
        },
    };

    return [press, () => performance.now() - firedAt.current < AFTER_HOLD_MS];
}
