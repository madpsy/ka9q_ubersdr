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
import FloatingPanel from './FloatingPanel.jsx';
import { Icon } from './ui.jsx';

// Minimised windows gather here, along the bottom of the centre area and so
// directly above the bottom dock. The panel body is dropped while minimised,
// exactly as a collapsed dock section drops its own — but the panel's badge is
// kept, so a chip can still say there is something to look at.
function MinimisedBar({ ids }) {
    const { setFloatMin, movePanel } = useLayout();
    if (!ids.length) return null;
    return (
        <div className="floatbar">
            {ids.map((id) => {
                const panel = PANEL_BY_ID[id];
                return (
                    <div key={id} className="floatchip">
                        <button
                            type="button"
                            className="floatchip__main"
                            title={`Restore ${panel.title}`}
                            onClick={() => setFloatMin(id, false)}
                        >
                            <span className="floatchip__icon">{panel.icon}</span>
                            <span className="floatchip__title">{panel.title}</span>
                            {panel.Badge && <panel.Badge />}
                        </button>
                        <button
                            type="button"
                            className="floatchip__btn"
                            title="Return to its dock"
                            onClick={() => movePanel(id, panel.dock, null)}
                        >
                            <Icon.Close size={12} />
                        </button>
                    </div>
                );
            })}
        </div>
    );
}

export default function FloatingLayer() {
    const { floats, floatOrder, sections, setFloat } = useLayout();
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
            const x = Math.max(60 - g.w, Math.min(b.width - 60, g.x));
            const y = Math.max(0, Math.min(b.height - 28, g.y));
            if (x !== g.x || y !== g.y) setFloat(id, { x, y });
        }
    }, [floats, setFloat, bounds.current && bounds.current.width, bounds.current && bounds.current.height]);

    const visible = floatOrder.filter((id) => PANEL_BY_ID[id] && !sections[id]?.hidden);
    // The chip strip keeps floatOrder, so minimising a window does not shuffle
    // the row; z-order among the remaining windows is unaffected either.
    const minimised = visible.filter((id) => floats[id]?.min);

    return (
        <div className="floatlayer" ref={ref}>
            {visible.filter((id) => !floats[id]?.min).map((id, i) => (
                <FloatingPanel
                    key={id}
                    panel={PANEL_BY_ID[id]}
                    geom={floats[id]}
                    z={i}
                    bounds={bounds}
                />
            ))}
            <MinimisedBar ids={minimised} />
            {/* Last, so an extension always paints above the panels: it is the
                thing the user just opened, and it has no raise-to-front of its
                own because there is only ever one. */}
            <ExtensionWindow bounds={bounds} />
        </div>
    );
}
