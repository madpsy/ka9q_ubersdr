// Something small, floating, placed at a point, dismissed by anything else.
//
// Extracted from SpectrumMenu, which is now one of two users: a menu is a list
// of buttons in a popover, and the top bar's filter width is a slider in one.
// The part worth sharing is not the content but the two things such a thing must
// always get right — being wholly on screen from wherever it was opened, and
// going away when the operator's attention does.
//
// Dismissal is on pointerdown *outside*, which is what makes a slider work in
// here: the drag begins inside, so moving the pointer across the whole screen
// and releasing over the waterfall never closes the popover mid-adjustment.

import React, { ReactDOM, useEffect, useLayoutEffect, useRef, useState } from '../react.js';

// Kept clear of the viewport edge so it never sits flush against it.
const EDGE = 8;

/**
 * @param at        {x, y} viewport point to place the top-left corner at.
 * @param remeasure changes when the content's size might have, so the placement
 *                  is worked out again. Not the children themselves: those are a
 *                  new object every render, and re-measuring on every render is
 *                  a loop.
 * @param autoFocus for a popover that exists to be typed into — the callsign box under the
 *                  top bar's lookup button. It has to be done here rather than with
 *                  React's own autoFocus on the input, because this thing paints hidden
 *                  until it has measured itself and a hidden element cannot take focus:
 *                  the attribute fires a frame too early and silently does nothing. So the
 *                  focus waits for the placement, which is the moment it becomes possible.
 */
export default function Popover({
    at, onClose, children, className = '', role = 'dialog', remeasure = 0,
    autoFocus = false, 'aria-label': ariaLabel,
}) {
    const ref = useRef(null);
    const [pos, setPos] = useState({ left: at.x, top: at.y, ready: false });

    // Measured, then placed: something whose height depends on its content
    // cannot know in advance whether it fits below the point it opened from.
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const maxLeft = window.innerWidth - r.width - EDGE;
        const maxTop = window.innerHeight - r.height - EDGE;
        setPos({
            left: Math.max(EDGE, Math.min(at.x, maxLeft)),
            top: Math.max(EDGE, Math.min(at.y, maxTop)),
            ready: true,
        });
    }, [at.x, at.y, remeasure]);

    // Once it is visible, and only then. `[data-autofocus]` wins where the content says
    // which element it means; otherwise the first thing that can be typed into, which for
    // a popover that wanted focus is what it wanted focus for.
    useEffect(() => {
        if (!autoFocus || !pos.ready) return;
        const el = ref.current;
        if (!el) return;
        const target = el.querySelector(
            '[data-autofocus], input:not([type=hidden]):not([disabled]), textarea:not([disabled])',
        );
        // preventScroll: the popover is fixed and already placed, and a browser scrolling
        // the page to bring a focused input into view would move everything under it.
        if (target) target.focus({ preventScroll: true });
    }, [autoFocus, pos.ready]);

    // Anything that is not a press inside closes it, including a second
    // right-click elsewhere — which then opens a fresh one where it landed.
    useEffect(() => {
        const away = (e) => {
            if (ref.current && ref.current.contains(e.target)) return;
            onClose();
        };
        const key = (e) => { if (e.key === 'Escape') onClose(); };
        // Capture, so a handler that stops propagation cannot strand it.
        document.addEventListener('pointerdown', away, true);
        document.addEventListener('contextmenu', away, true);
        document.addEventListener('keydown', key);
        window.addEventListener('blur', onClose);
        window.addEventListener('resize', onClose);
        return () => {
            document.removeEventListener('pointerdown', away, true);
            document.removeEventListener('contextmenu', away, true);
            document.removeEventListener('keydown', key);
            window.removeEventListener('blur', onClose);
            window.removeEventListener('resize', onClose);
        };
    }, [onClose]);

    // A portal, like Modal's: `fixed` is only viewport-relative while no
    // ancestor establishes a containing block, and the top bar now does — its
    // `contain: paint` (a repaint fix, see .topbar in styles.css) both re-bases
    // fixed descendants and clips them to the bar, so a popover opened from it
    // was placed just below the bar and clipped to nothing. <body> is the one
    // parent guaranteed never to trap it.
    return ReactDOM.createPortal(
        <div
            ref={ref}
            className={`specmenu ${className}`.trim()}
            role={role}
            aria-label={ariaLabel}
            // Hidden until measured, or the first paint shows it at the click
            // point and it visibly jumps to where it fits.
            style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}
        >
            {children}
        </div>,
        document.body,
    );
}
