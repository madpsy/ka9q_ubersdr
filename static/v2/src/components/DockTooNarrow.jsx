// A panel that needs the width a side dock has not got, saying so.
//
// Two panels are like this and for the same reason. The cluster terminal is eighty
// columns of fixed-pitch text; the chat room is a name, a time and a sentence per line,
// with a user list beside it. A side dock is 220 to 560 pixels wide, which wraps every
// line of either into three — and both are fine in the bottom dock, which is as wide as
// the window, or in a floating window sized once and left alone.
//
// So in a side dock they do not pretend. They say where they belong and offer the two
// places they work.
//
// The alternative — letting them render badly — is worse than it sounds: a panel that is
// technically working is a panel nobody moves, so the operator concludes the feature is
// poor rather than that it is in the wrong place. This is the same judgement as the
// bottom dock not being their default: that dock is the busiest by default, and a
// receiver that opens with a terminal and a chat room across the bottom of the screen
// has led with the wrong thing.

import React from '../react.js';
import { Button } from './ui.jsx';
import { useLayout } from '../layout/LayoutContext.jsx';
import { MOBILE_QUERY, useMediaQuery } from '../lib/useMediaQuery.js';

// What a panel floats at when it is floated from here.
//
// The layout's own default is 320 across, which is the width these panels refuse to draw
// in — floating one from the signpost and landing in the same predicament would be a
// button that does not work. Each panel says what it needs; this is the fallback.
export const FLOAT_FALLBACK = { w: 560, h: 460 };

/**
 * Trimmed to the window, because a panel opening wider than the screen is a panel with
 * its Close button off the edge.
 */
export function floatSize(want = FLOAT_FALLBACK) {
    const vw = typeof window === 'undefined' ? want.w : window.innerWidth;
    const vh = typeof window === 'undefined' ? want.h : window.innerHeight;
    return {
        w: Math.max(320, Math.min(want.w, vw - 80)),
        h: Math.max(240, Math.min(want.h, vh - 120)),
    };
}

/**
 * Where the panel is, and the two ways out of it.
 *
 * `cramped` is never true on a phone. There are no docks there — every panel is a
 * full-width sheet, which is as much room as the device has — so the signpost would be
 * replacing a usable panel with two buttons that lead nowhere. The panel keeps its dock
 * in the stored layout for when the same layout is opened on a desktop, which is why the
 * placement still says 'left' there and has to be ignored.
 */
export function useDockRoom(id, want = FLOAT_FALLBACK) {
    const { placementOf, movePanel, setFloat, floats } = useLayout();
    const mobile = useMediaQuery(MOBILE_QUERY);
    const where = placementOf(id);
    const cramped = !mobile && (where === 'left' || where === 'right');

    const toBottom = () => movePanel(id, 'bottom', null);

    // Both updates are queued on the same state, so the resize lands after the move that
    // creates the window.
    //
    // Only when it would otherwise be too narrow: a window somebody has already sized
    // and dragged is theirs, and re-imposing a default every time it is floated again
    // would undo that silently.
    const floatIt = () => {
        movePanel(id, 'float', null);
        const size = floatSize(want);
        const had = floats && floats[id];
        if (!had || had.w < size.w) setFloat(id, size);
    };

    return { where, cramped, toBottom, floatIt };
}

/**
 * The signpost itself: one line saying why, and the two places that work.
 *
 * Stacked and full width rather than side by side: at the width that makes the panel
 * unusable, two buttons in a row are two buttons nobody can read either.
 */
export default function DockTooNarrow({ note, onBottom, onFloat }) {
    return (
        <div className="stack too-narrow">
            <p className="too-narrow__note">{note}</p>
            <div className="too-narrow__buttons">
                <Button size="sm" variant="primary" onClick={onBottom}>
                    Dock at the bottom
                </Button>
                <Button size="sm" variant="ghost" onClick={onFloat}>
                    Float it
                </Button>
            </div>
        </div>
    );
}
