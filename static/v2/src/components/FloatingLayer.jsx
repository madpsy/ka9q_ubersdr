// Overlay holding every floating panel. Covers the centre area only, so a
// window can never hide the top bar, and is click-through except over a window.

import React, { useEffect, useRef, useState } from '../react.js';
import { useLayout } from '../layout/LayoutContext.jsx';
import { PANEL_BY_ID } from '../panels/registry.jsx';
import FloatingPanel from './FloatingPanel.jsx';

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

    return (
        <div className="floatlayer" ref={ref}>
            {visible.map((id, i) => (
                <FloatingPanel
                    key={id}
                    panel={PANEL_BY_ID[id]}
                    geom={floats[id]}
                    z={i}
                    bounds={bounds}
                />
            ))}
        </div>
    );
}
