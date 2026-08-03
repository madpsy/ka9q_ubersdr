// A dock: an ordered, resizable, collapsible column (or, for `bottom`, a row)
// of sections. Also the drop target for panels dragged past the last section.

import React, { useCallback, useRef, useState } from '../react.js';
import { useLayout } from '../layout/LayoutContext.jsx';
import { PANEL_BY_ID } from '../panels/registry.jsx';
import Section from './Section.jsx';
import { Icon } from './ui.jsx';
import { useDragEndReset } from '../lib/useDragEnd.js';

// Drag handle between two bottom-dock panels. Converts a pixel delta into a
// share of the pair's combined width, so the rest of the row is undisturbed.
function SectionSplitter({ before, after, weights, setWeights }) {
    const drag = useRef(null);

    const onDown = (e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const row = e.currentTarget.parentElement;
        const kids = [...row.children];
        const me = kids.indexOf(e.currentTarget);
        const a = kids[me - 1];
        const b = kids[me + 1];
        if (!a || !b) return;
        drag.current = {
            x: e.clientX,
            aw: a.getBoundingClientRect().width,
            bw: b.getBoundingClientRect().width,
            wa: weights[before] || 1,
            wb: weights[after] || 1,
        };
    };

    const onMove = (e) => {
        const d = drag.current;
        if (!d) return;
        const total = d.aw + d.bw;
        if (total <= 0) return;
        const MIN = 140;
        const aw = Math.max(MIN, Math.min(total - MIN, d.aw + (e.clientX - d.x)));
        const sum = d.wa + d.wb;
        const wa = (aw / total) * sum;
        setWeights([[before, wa], [after, sum - wa]]);
    };

    const onUp = (e) => {
        drag.current = null;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    };

    return (
        <div
            className="dock__split"
            title="Drag to resize — double-click to even out"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onDoubleClick={() => setWeights([[before, 1], [after, 1]])}
        />
    );
}

const COLLAPSE_ICON = {
    left: { open: <Icon.ChevronLeft size={14} />, closed: <Icon.ChevronRight size={14} /> },
    right: { open: <Icon.ChevronRight size={14} />, closed: <Icon.ChevronLeft size={14} /> },
    bottom: { open: <Icon.Chevron size={14} />, closed: <Icon.Chevron size={14} /> },
};

export default function Dock({ side }) {
    const { docks, sections, toggleDock, setDockSize, movePanel, weights, setWeights, heights } = useLayout();
    const dock = docks[side];
    const [dropping, setDropping] = useState(false);
    const resizeRef = useRef(null);

    // Covers a cancelled drag (Escape), where no drop fires at all. It cannot
    // cover a completed drop: moving the panel unmounts the drag source, so its
    // dragend no longer bubbles to the window — the drop itself clears that,
    // which is why Section lets the event through instead of stopping it.
    const clearDropping = useCallback(() => setDropping(false), []);
    useDragEndReset(dropping, clearDropping);

    const visible = dock.panels.filter((id) => PANEL_BY_ID[id] && !sections[id]?.hidden);

    const onResizeDown = useCallback((e) => {
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        resizeRef.current = { start: side === 'bottom' ? e.clientY : e.clientX, size: dock.size };
    }, [dock.size, side]);

    const onResizeMove = useCallback((e) => {
        const r = resizeRef.current;
        if (!r) return;
        // Left dock grows rightwards; right and bottom grow the other way.
        const delta = side === 'left'
            ? e.clientX - r.start
            : side === 'right'
                ? r.start - e.clientX
                : r.start - e.clientY;
        setDockSize(side, r.size + delta);
    }, [side, setDockSize]);

    const onResizeUp = useCallback((e) => {
        resizeRef.current = null;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }, []);

    const style = dock.collapsed
        ? undefined
        : side === 'bottom'
            ? { height: dock.size }
            : { width: dock.size };

    if (dock.collapsed) {
        return (
            <div className={`dock dock--${side} is-collapsed`}>
                <button
                    type="button"
                    className="dock__rail"
                    onClick={() => toggleDock(side)}
                    title={`Show ${side} panels`}
                >
                    <span className="dock__rail-icon">{COLLAPSE_ICON[side].closed}</span>
                    <span className="dock__rail-label">
                        {visible.map((id) => PANEL_BY_ID[id].title).join(' · ') || 'Panels'}
                    </span>
                </button>
            </div>
        );
    }

    return (
        <div className={`dock dock--${side}`} style={style}>
            <div className="dock__header">
                <span className="dock__name">{side} panels</span>
                <button type="button" className="dock__collapse" title="Collapse" onClick={() => toggleDock(side)}>
                    {COLLAPSE_ICON[side].open}
                </button>
            </div>

            <div
                className={`dock__body${dropping ? ' is-dropping' : ''}`}
                onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes('text/ubersdr-panel')) return;
                    e.preventDefault();
                    setDropping(true);
                }}
                onDragLeave={() => setDropping(false)}
                onDrop={(e) => {
                    setDropping(false);
                    // A section inside this dock may have placed it already.
                    if (e.panelDropHandled) return;
                    const id = e.dataTransfer.getData('text/ubersdr-panel');
                    if (id) movePanel(id, side, null);
                }}
            >
                {visible.map((id, i) => (
                    <React.Fragment key={id}>
                        {/* Only the bottom dock lays panels out side by side, so
                            only it has anything to split. The side docks size
                            panels to their content and let the dock scroll. */}
                        {side === 'bottom' && i > 0 && (
                            <SectionSplitter
                                before={visible[i - 1]}
                                after={id}
                                weights={weights}
                                setWeights={setWeights}
                            />
                        )}
                        <Section
                            panel={PANEL_BY_ID[id]}
                            dock={side}
                            index={i}
                            weight={side === 'bottom' ? (weights[id] || 1) : undefined}
                            height={side === 'bottom' ? heights[id] : undefined}
                        />
                    </React.Fragment>
                ))}
                {visible.length === 0 && <div className="dock__empty">Drop a panel here</div>}
            </div>

            <div
                className={`dock__resizer dock__resizer--${side}`}
                onPointerDown={onResizeDown}
                onPointerMove={onResizeMove}
                onPointerUp={onResizeUp}
                onPointerCancel={onResizeUp}
                onDoubleClick={() => setDockSize(side, side === 'bottom' ? 240 : 320)}
            />
        </div>
    );
}
