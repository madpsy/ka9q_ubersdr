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

import React from '../react.js';
import { useLayout } from '../layout/LayoutContext.jsx';
import { useDisplay, UI_SCALE_MAX, UI_SCALE_MIN, UI_SCALE_STEP } from '../display/DisplayContext.jsx';
import { Icon } from './ui.jsx';
import { canScale, nudgeScale, panelScale } from '../lib/panelScale.js';

const RANGE = { min: UI_SCALE_MIN, max: UI_SCALE_MAX, step: UI_SCALE_STEP };

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

    // Says where it is now and, when that is not the global size, what the
    // global size is — which is the question somebody who has nudged a panel and
    // come back to it a day later is actually asking.
    const where = delta ? `${pct(scale)}, global ${pct(base)}` : `${pct(scale)}`;

    return (
        /* One box around the two, with no gap between them: they are one control
           with two directions, and the title bars they sit in space their
           buttons out far enough that a loose pair would read as two unrelated
           magnifiers. `flex: none` because the bars around it never measure
           their own contents — see useWiderThan. */
        <span className="panelzoom">
            <button
                type="button"
                className={className}
                title={`Smaller text in this panel — ${where}`}
                aria-label="Smaller text in this panel"
                disabled={!canScale(base, delta, -1, RANGE)}
                onClick={() => setSectionScale(panelId, nudgeScale(base, delta, -1, RANGE))}
            >
                <Icon.ZoomOut size={size} />
            </button>
            <button
                type="button"
                className={className}
                title={`Larger text in this panel — ${where}`}
                aria-label="Larger text in this panel"
                disabled={!canScale(base, delta, 1, RANGE)}
                onClick={() => setSectionScale(panelId, nudgeScale(base, delta, 1, RANGE))}
            >
                <Icon.ZoomIn size={size} />
            </button>
        </span>
    );
}
