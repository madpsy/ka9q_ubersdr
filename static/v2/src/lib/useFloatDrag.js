// Dragging and resizing a floating window.
//
// Shared by the two kinds of window that float over the centre area: a docked
// panel that was detached (components/FloatingPanel.jsx) and an extension,
// which only ever floats (extensions/ExtensionWindow.jsx). They differ in where
// their geometry is stored, so that stays with the caller — this owns the
// pointer gesture, which is the part where the bugs live.

import { useCallback, useRef } from '../react.js';

// How much of a window must stay on screen, so one can never be dragged fully
// out of reach, and the strip of title bar that must stay below the top edge.
export const EDGE_KEEP = 60;
export const HEAD_KEEP = 28;

/**
 * Where a window of width `w` may sit in a layer `b` ({width, height}) wide,
 * given where it is being asked to go.
 *
 * Exported because this is the *only* rule about where a floating window is
 * allowed to be, and anything else that moves one has to agree with it. A
 * second, stricter rule elsewhere does not read as a stricter rule: it reads as
 * a window that will not stay where it is put, and if the two disagree while a
 * drag is running, as one that shakes. See the fit in ExtensionWindow.
 */
export function keepOnScreen(x, y, w, b) {
    const width = b ? b.width : Infinity;
    const height = b ? b.height : Infinity;
    return {
        x: Math.max(EDGE_KEEP - w, Math.min(width - EDGE_KEEP, x)),
        y: Math.max(0, Math.min(height - HEAD_KEEP, y)),
    };
}

/**
 * geom     { x, y, w, h } — current geometry
 * bounds   ref to { width, height } of the layer, or null before it is measured
 * min      { w, h } floor for a resize
 * onChange (patch) => void — called with the part of the geometry that moved
 * onRaise  () => void — called when a gesture starts, for click-to-front
 */
export function useFloatDrag({ geom, bounds, min, onChange, onRaise }) {
    const drag = useRef(null);

    // Both dragging and resizing run through one pointer handler; `mode` says
    // whether the pointer delta moves the window or grows it. The pointer
    // origin is deliberately named apart from the geometry — spreading `geom`
    // over `{x, y}` would silently overwrite it and make the window jump to the
    // cursor on the first move.
    const start = useCallback((e, mode) => {
        // A press that begins on a title-bar control must not start a drag.
        // preventDefault() here would suppress the compatibility mouse events
        // the button's click depends on, and setPointerCapture() would redirect
        // the rest of the gesture to the header — between them the menu never
        // opens and the close button never fires.
        // `.menu` covers the trigger and, when a dropdown renders in place,
        // its panel: a press on a menu item would otherwise reach the drag
        // handler and have its click swallowed the same way.
        if (mode === 'move' && e.target && e.target.closest && e.target.closest('.floatwin__ctl, .menu')) return;
        // ...and the same press when the dropdown is *portalled*. React bubbles
        // events from a portal to the React parent, so a menu panel rendered
        // into <body> still arrives at this header — while `closest('.menu')`
        // cannot see it, because in the DOM it is nowhere near here. That is
        // precisely how the dock items in a floating window's options menu
        // stopped being clickable when Menu started portalling its panel: the
        // menu opened, and every item was dead.
        //
        // Asking whether the press landed in this header's own subtree is the
        // question that stays true whatever gets portalled next, rather than a
        // list of class names that goes stale the moment one of them moves.
        if (mode === 'move' && e.currentTarget && e.target
            && e.currentTarget.contains && !e.currentTarget.contains(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        if (onRaise) onRaise();
        drag.current = { mode, px: e.clientX, py: e.clientY, ...geom };
    }, [geom, onRaise]);

    const move = useCallback((e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.px;
        const dy = e.clientY - d.py;
        const max = bounds && bounds.current;
        if (d.mode === 'move') {
            onChange(keepOnScreen(d.x + dx, d.y + dy, d.w, max));
        } else {
            onChange({
                w: Math.max(min ? min.w : 0, d.w + dx),
                h: Math.max(min ? min.h : 0, d.h + dy),
            });
        }
    }, [bounds, min, onChange]);

    const end = useCallback((e) => {
        drag.current = null;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }, []);

    return {
        onMoveDown: (e) => start(e, 'move'),
        onSizeDown: (e) => start(e, 'size'),
        onMove: move,
        onEnd: end,
    };
}
