// Overlay holding every floating window. Covers the centre area only, so a
// window can never hide the top bar, and is click-through except over a window.
//
// Two kinds of window live here: panels the user detached from a dock, and the
// open extension — which only ever floats. They share this layer so they share
// its measured bounds, and so an extension is dragged and clamped by exactly
// the same rules as a panel.

import React, { useEffect, useRef, useState } from '../react.js';
import { useLayout } from '../layout/LayoutContext.jsx';
import { PANEL_BY_ID } from '../panels/registry.jsx';
import ExtensionWindow from '../extensions/ExtensionWindow.jsx';
import { useExtensions } from '../extensions/ExtensionsContext.jsx';
import FloatingPanel from './FloatingPanel.jsx';
import { Icon } from './ui.jsx';

// Minimised windows gather here, along the bottom of the centre area and so
// directly above the bottom dock. Panels and the extension share the strip:
// both are floating windows, so both minimise to the same place.
//
// A minimised panel drops its body, exactly as a collapsed dock section drops
// its own, but keeps its badge — so a chip can still say there is something to
// look at. The extension is different and stays mounted; see ExtensionWindow.
function MinimisedBar({ chips }) {
    if (!chips.length) return null;
    return (
        <div className="floatbar">
            {chips.map((c) => (
                <div key={c.key} className="floatchip">
                    <button
                        type="button"
                        className="floatchip__main"
                        title={`Restore ${c.title}`}
                        onClick={c.onRestore}
                    >
                        <span className="floatchip__icon">{c.icon}</span>
                        <span className="floatchip__title">{c.title}</span>
                        {c.Badge && <c.Badge />}
                    </button>
                    <button
                        type="button"
                        className="floatchip__btn"
                        title={c.dismissTitle}
                        onClick={c.onDismiss}
                    >
                        <Icon.Close size={12} />
                    </button>
                </div>
            ))}
        </div>
    );
}

// Where a corner puts a window, given how big the layer turned out to be.
//
// The gap is the same all round and small: these are windows a layout seeded on
// purpose, so they should look placed rather than dropped, and a margin wide
// enough to read as deliberate is also wide enough to waste the corner. A window
// too tall for the layer is pinned to the top rather than pushed off it — the
// title bar is the part you need to reach to move or resize it.
const ANCHOR_GAP = 12;

function resolveAnchor(g, b) {
    const bottom = String(g.anchor).includes('bottom');
    const right = String(g.anchor).includes('right');
    return {
        x: right ? Math.max(ANCHOR_GAP, b.width - g.w - ANCHOR_GAP) : ANCHOR_GAP,
        y: bottom ? Math.max(ANCHOR_GAP, b.height - g.h - ANCHOR_GAP) : ANCHOR_GAP,
    };
}

export default function FloatingLayer() {
    const { floats, floatOrder, sections, setFloat, setFloatMin, movePanel } = useLayout();
    const ext = useExtensions();
    const ref = useRef(null);
    const bounds = useRef(null);
    const [, force] = useState(0);

    // Track the layer size so drags can clamp, and so windows left off-screen by
    // a smaller viewport get pulled back into view.
    useEffect(() => {
        const el = ref.current;
        if (!el) return undefined;
        const ro = new ResizeObserver(() => {
            const r = el.getBoundingClientRect();
            bounds.current = { width: r.width, height: r.height };
            force((n) => n + 1);
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    useEffect(() => {
        const b = bounds.current;
        // Only once the layer has a real size. Clamping against an unmeasured
        // or collapsed layer would rewrite every stored position to the top-left
        // corner — and persist it.
        if (!b || b.width < 120 || b.height < 120) return;
        for (const [id, g] of Object.entries(floats)) {
            // A window the layout seeded rather than a person placed carries a
            // corner instead of a position, because only this layer knows how
            // much room there is. Resolving it here also means it lands right
            // whatever the docks around it are doing — a collapsed bottom dock
            // and an open one give the centre area very different heights.
            // setFloat drops the anchor, so this happens exactly once.
            if (g.anchor) {
                setFloat(id, resolveAnchor(g, b));
                continue;
            }
            const x = Math.max(60 - g.w, Math.min(b.width - 60, g.x));
            const y = Math.max(0, Math.min(b.height - 28, g.y));
            if (x !== g.x || y !== g.y) setFloat(id, { x, y });
        }
    }, [floats, setFloat, bounds.current && bounds.current.width, bounds.current && bounds.current.height]);

    const visible = floatOrder.filter((id) => PANEL_BY_ID[id] && !sections[id]?.hidden);
    // The chip strip keeps floatOrder, so minimising a window does not shuffle
    // the row; z-order among the remaining windows is unaffected either. The
    // extension chip goes last, matching where its window paints.
    const chips = visible.filter((id) => floats[id]?.min).map((id) => {
        const panel = PANEL_BY_ID[id];
        return {
            key: id,
            title: panel.title,
            icon: panel.icon,
            Badge: panel.Badge,
            onRestore: () => setFloatMin(id, false),
            onDismiss: () => movePanel(id, panel.dock, null),
            dismissTitle: 'Return to its dock',
        };
    });
    if (ext.active && ext.minimised) {
        chips.push({
            key: `ext:${ext.active.id}`,
            title: ext.active.title,
            icon: ext.active.icon,
            onRestore: () => ext.setMinimised(false),
            onDismiss: ext.close,
            dismissTitle: 'Close this extension',
        });
    }

    return (
        <div className="floatlayer" ref={ref}>
            {/* Minimised windows are rendered too, and hidden by FloatingPanel.
                Dropping them from the tree is what a *collapse* means — and it
                logs the DX cluster panel out and stops a decoder decoding, which
                is not what putting a window on the strip for a minute asks for.
                They keep their place in floatOrder, so nothing shuffles when one
                comes back, and their z is irrelevant while they are invisible. */}
            {visible.map((id, i) => (
                <FloatingPanel
                    key={id}
                    panel={PANEL_BY_ID[id]}
                    geom={floats[id]}
                    z={i}
                    minimised={!!floats[id]?.min}
                    bounds={bounds}
                />
            ))}
            <MinimisedBar chips={chips} />
            {/* Last, so an extension always paints above the panels: it is the
                thing the user just opened, and it has no raise-to-front of its
                own because there is only ever one. */}
            <ExtensionWindow bounds={bounds} />
        </div>
    );
}
