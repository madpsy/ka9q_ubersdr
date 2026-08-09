// The zoom pair in a panel's title bar, and the size it produces.
//
// One component for all three chromes — a docked section, a floating window, a
// mobile sheet — because it is the same control saying the same thing in each,
// and because the arithmetic behind it (lib/panelScale.js) has to be applied in
// exactly one place or the three would disagree about what 100% means.
//
// A pair, not a cycle and not a menu: two directions is what a size control is,
// it is what the top bar's global zoom already looks like, and a magnifier with
// a plus in it needs no explaining to anybody who has used a browser.
//
// Getting back is the third thing a size control needs, and the pair has no room
// for a third button — the top bar can afford a percentage between its two
// magnifiers, a 220px dock header cannot. So it is the secondary press on the
// buttons already there: right-click with a mouse, hold with a finger, either
// one on either button. Both are the conventional "the other thing this does",
// neither costs a pixel, and the panel snapping back to the size of everything
// around it is its own confirmation that something happened.

import React, { useCallback, useEffect, useRef } from '../react.js';
import { useLayout } from '../layout/LayoutContext.jsx';
import { useDisplay, UI_SCALE_MAX, UI_SCALE_MIN, UI_SCALE_STEP } from '../display/DisplayContext.jsx';
import { Icon } from './ui.jsx';
import { haptic } from '../lib/haptics.js';
import { canScale, nudgeScale, panelScale } from '../lib/panelScale.js';

const RANGE = { min: UI_SCALE_MIN, max: UI_SCALE_MAX, step: UI_SCALE_STEP };

// Long enough not to fire on a firm tap, short enough to find by accident, and
// the same figure Minesweeper's flag press uses — one hold length across the app
// is one thing to learn.
const HOLD_MS = 450;

// A click that lands within this of a reset is the tail of the gesture that did
// it, not a press of its own. A timestamp rather than a flag, as the top bar's
// menu buttons do it: a flag has to be cleared by an event that may never come —
// a right-click fires no click at all — and one left set would swallow the next
// real press instead.
const AFTER_RESET_MS = 400;

const pct = (v) => `${Math.round(v * 100)}%`;

/**
 * What one panel is drawn at, and what to put on the element that draws it.
 *
 * `style` sets --ui-scale for that subtree only. Every font size in styles.css
 * is calc(Npx * var(--ui-scale)) against the one the display settings put on the
 * root, so a panel overriding it locally is the whole mechanism — no second
 * variable, and nothing to keep in step.
 */
export function usePanelScale(panelId) {
    const { sections } = useLayout();
    const display = useDisplay();
    const base = display.uiScale ?? 1;
    const delta = sections[panelId]?.scale || 0;
    const scale = panelScale(base, delta, RANGE);
    return {
        base,
        delta,
        scale,
        // Nothing at all when the panel is in step with everything else: an
        // inline variable that merely restates the inherited one is a thing to
        // read and wonder about in the inspector.
        style: delta ? { '--ui-scale': scale } : undefined,
    };
}

export default function PanelZoom({ panelId, className, size = 13 }) {
    const { setSectionScale } = useLayout();
    const { base, delta, scale } = usePanelScale(panelId);

    const hold = useRef(null);
    const resetAt = useRef(0);
    useEffect(() => () => clearTimeout(hold.current), []);

    const reset = useCallback(() => {
        resetAt.current = performance.now();
        if (!delta) return;
        setSectionScale(panelId, 0);
        // The one press here whose effect is not a step of type size, so it is
        // the one that has to say it landed on a device with no pointer to see.
        haptic('toggle');
    }, [delta, panelId, setSectionScale]);

    const step = (dir) => () => {
        // The click a hold leaves behind. Ignored rather than prevented: a touch
        // dispatches its compatibility click well after the timer has fired, and
        // by then there is nothing left to cancel.
        if (performance.now() - resetAt.current < AFTER_RESET_MS) return;
        setSectionScale(panelId, nudgeScale(base, delta, dir, RANGE));
    };

    // Touch only. A mouse has the right button for this, and a mouse held still
    // on a button is somebody reading the tooltip.
    const onPointerDown = (e) => {
        if (e.pointerType === 'mouse') return;
        clearTimeout(hold.current);
        hold.current = setTimeout(reset, HOLD_MS);
    };
    const endHold = () => clearTimeout(hold.current);

    // Right-click, and on Android the long press arrives here as well — which is
    // harmless, because resetting twice is resetting once.
    const onContextMenu = (e) => {
        e.preventDefault();
        reset();
    };

    const press = {
        onPointerDown,
        onPointerUp: endHold,
        onPointerCancel: endHold,
        onPointerLeave: endHold,
        onContextMenu,
    };

    // Says where it is now and, when that is not the global size, what the
    // global size is — which is the question somebody who has nudged a panel and
    // come back to it a day later is actually asking.
    const where = delta
        ? `${pct(scale)}, global ${pct(base)} — right-click or hold to go back to the global size`
        : `${pct(scale)}`;

    return (
        /* One box around the two, with no gap between them: they are one control
           with two directions, and the title bars they sit in space their
           buttons out far enough that a loose pair would read as two unrelated
           magnifiers. `flex: none` because a title bar's optional control is
           dropped when the room runs out, never squeezed — see
           lib/headerRoom.js. */
        <span className="panelzoom">
            <button
                type="button"
                className={className}
                title={`Smaller text in this panel — ${where}`}
                aria-label="Smaller text in this panel"
                disabled={!canScale(base, delta, -1, RANGE)}
                onClick={step(-1)}
                {...press}
            >
                <Icon.ZoomOut size={size} />
            </button>
            <button
                type="button"
                className={className}
                title={`Larger text in this panel — ${where}`}
                aria-label="Larger text in this panel"
                disabled={!canScale(base, delta, 1, RANGE)}
                onClick={step(1)}
                {...press}
            >
                <Icon.ZoomIn size={size} />
            </button>
        </span>
    );
}
