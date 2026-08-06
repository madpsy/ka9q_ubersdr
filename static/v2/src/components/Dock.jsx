// A dock: an ordered, resizable, collapsible column (or, for `bottom`, a row)
// of sections. Also the drop target for panels dragged past the last section.

import React, { useCallback, useEffect, useRef, useState } from '../react.js';
import { useLayout } from '../layout/LayoutContext.jsx';
import { useDisplay } from '../display/DisplayContext.jsx';
import { useMediaQuery } from '../lib/useMediaQuery.js';
import { PANEL_BY_ID, usePanelApplies } from '../panels/registry.jsx';
import Section from './Section.jsx';
import { Icon } from './ui.jsx';
import { useDragEndReset } from '../lib/useDragEnd.js';

// A panel's share of the bottom dock's width: what the operator dragged it to,
// otherwise what the panel asks for, otherwise an equal share. Reading the
// registry here rather than seeding the stored layout means a declared width
// reaches everyone, not only whoever installs v2 next — a stored layout is
// never rewritten by a release.
function shareOf(weights, id) {
    const stored = weights && weights[id];
    if (stored) return stored;
    const panel = PANEL_BY_ID[id];
    return (panel && panel.weight) || 1;
}

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
            wa: shareOf(weights, before),
            wb: shareOf(weights, after),
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

// Long enough that crossing the rail on the way somewhere else does nothing;
// short enough that stopping on it feels like a hover rather than a wait.
const PEEK_OPEN_MS = 260;
// Covers the gap between the rail and the overlay, and a hand that wanders.
const PEEK_CLOSE_MS = 320;

export default function Dock({ side }) {
    const {
        docks, sections, toggleDock, setDockSize, movePanel, movePanelNear, weights, setWeights,
        heights,
    } = useLayout();
    const applies = usePanelApplies();
    const dock = docks[side];
    const [dropping, setDropping] = useState(false);
    const resizeRef = useRef(null);

    // ---- hover to peek --------------------------------------------------
    //
    // Both edges are delayed, and they are delayed by different amounts.
    //
    // Opening waits longer, because the rail sits between the spectrum and the
    // window edge and the pointer crosses it on its way to anything else. An
    // instant open would fire while you were reaching for a scrollbar.
    //
    // Closing waits too, and for the more important reason: the pointer has to
    // travel from the rail into the overlay, and for part of that journey it is
    // over neither. Without the delay the dock would shut in the gap.
    const display = useDisplay();
    // Only where hovering is a thing the pointer does. On a touch screen
    // pointerenter fires on the tap that is already toggling the dock, so the
    // panel would open and instantly close again.
    const canHover = useMediaQuery('(hover: hover) and (pointer: fine)');
    const peekEnabled = display.hoverPanels !== false && canHover;
    const [peeking, setPeeking] = useState(false);
    const peekTimer = useRef(null);

    const clearPeekTimer = () => { clearTimeout(peekTimer.current); peekTimer.current = null; };

    const startPeek = useCallback(() => {
        if (!peekEnabled) return;
        clearPeekTimer();
        peekTimer.current = setTimeout(() => setPeeking(true), PEEK_OPEN_MS);
    }, [peekEnabled]);

    const endPeek = useCallback(() => {
        clearPeekTimer();
        peekTimer.current = setTimeout(() => setPeeking(false), PEEK_CLOSE_MS);
    }, []);

    const cancelClose = useCallback(() => clearPeekTimer(), []);

    // Turning the setting off, or a dock the operator has just opened for real,
    // must not leave an overlay behind.
    useEffect(() => {
        if (!peekEnabled || !dock.collapsed) { clearPeekTimer(); setPeeking(false); }
    }, [peekEnabled, dock.collapsed]);

    useEffect(() => clearPeekTimer, []);

    // ---- where the dock was scrolled to ---------------------------------
    //
    // A peek is a fresh mount every time: the overlay only exists while the
    // pointer is on the rail, so the body it renders is a new element with a new
    // scrollTop of zero. On a dock whose panels run past its height — which is
    // most of them, since side docks size panels to their content and let the
    // dock scroll — that means every glance opens at the top and the panel you
    // were actually looking at is somewhere below the fold.
    //
    // So the offset is kept here, on the Dock itself, which survives peeks
    // opening and closing because only its inner branch changes. Both axes: the
    // bottom dock lays panels out in a row and scrolls sideways.
    //
    // Restored in a callback ref rather than an effect, so it is set in the same
    // commit the body is attached in and the dock never paints at the top before
    // jumping. React attaches children first, so there is content to restore
    // into by the time this runs.
    const scrollAt = useRef({ top: 0, left: 0 });
    // What the restore below actually achieved, which is not always what it
    // asked for: a panel still fetching its list is short, and the browser
    // clamps a scrollTop the content cannot reach. That write fires a scroll
    // event like any other, and recording it would throw the real position away
    // the moment it was restored — so the echo of our own write is ignored, and
    // the offset survives until the operator scrolls somewhere themselves.
    const echo = useRef(null);

    // The body element itself, for the drop geometry below — bodyRef is a
    // callback ref and has no `.current` of its own.
    const bodyEl = useRef(null);

    const bodyRef = useCallback((el) => {
        bodyEl.current = el;
        if (!el) return;
        el.scrollTop = scrollAt.current.top;
        el.scrollLeft = scrollAt.current.left;
        echo.current = { top: el.scrollTop, left: el.scrollLeft };
    }, []);

    const onBodyScroll = useCallback((e) => {
        const top = e.currentTarget.scrollTop;
        const left = e.currentTarget.scrollLeft;
        const was = echo.current;
        if (was && was.top === top && was.left === left) return;
        echo.current = null;
        scrollAt.current = { top, left };
    }, []);

    // Covers a cancelled drag (Escape), where no drop fires at all. It cannot
    // cover a completed drop: moving the panel unmounts the drag source, so its
    // dragend no longer bubbles to the window — the drop itself clears that,
    // which is why Section lets the event through instead of stopping it.
    const clearDropping = useCallback(() => setDropping(false), []);
    useDragEndReset(dropping, clearDropping);

    const visible = dock.panels.filter((id) => {
        const p = PANEL_BY_ID[id];
        if (!p || sections[id]?.hidden) return false;
        // A panel that does not apply to this server is not merely hidden — it
        // is absent, so it never shows an empty slot or a "not available" note.
        return applies(p);
    });

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

    // Which section a pointer is nearest, and which side of it — for a drop that
    // landed in the dock but not on a panel. Measured from the DOM rather than
    // from the layout, because it is answering a question about pixels.
    const nearestSection = useCallback((clientX, clientY) => {
        const body = bodyEl.current;
        if (!body) return null;
        const vertical = side !== 'bottom';
        const pos = vertical ? clientY : clientX;
        let best = null;
        let bestDist = Infinity;
        for (const el of body.querySelectorAll('[data-panel]')) {
            const r = el.getBoundingClientRect();
            const mid = vertical ? r.top + r.height / 2 : r.left + r.width / 2;
            const d = Math.abs(pos - mid);
            if (d < bestDist) {
                bestDist = d;
                best = { id: el.dataset.panel, edge: pos < mid ? 'before' : 'after' };
            }
        }
        return best;
    }, [side]);

    // Computed even while collapsed: the peek overlay is the same markup and
    // needs the same size, and the collapsed rail does not use it.
    const style = side === 'bottom' ? { height: dock.size } : { width: dock.size };

    // Peeking: the dock is collapsed, and the pointer is over its rail.
    //
    // Rendered as an overlay rather than by un-collapsing, so the centre area
    // does not reflow. A dock that opened in flow would resize the spectrum
    // canvas and rebuild the waterfall's history every time the pointer crossed
    // the rail, which is a high price for a glance.
    //
    // It never writes `collapsed`. That flag is the operator's own answer and
    // is only ever changed by clicking — see the note in LayoutContext. So a
    // dock left open stays open, a dock closed by hand stays closed, and a peek
    // is forgotten the moment the pointer leaves.
    const expanded = (extra) => (
        <div className={`dock dock--${side}${extra.className || ''}`} style={style} {...extra.props}>
            {/* The whole header collapses the dock, the way a panel's header
                opens and closes it. One button rather than a bar with a button
                inside it, so there is no nested click target to disagree. */}
            <button
                type="button"
                className="dock__header"
                // In a peek this header is what pins the dock open, so it must
                // not offer to collapse something that is already collapsed.
                title={dock.collapsed ? `Keep ${side} panels open` : `Collapse ${side} panels`}
                aria-expanded={!dock.collapsed}
                onClick={() => toggleDock(side)}
            >
                <span className="dock__name">{side} panels</span>
                <span className="dock__collapse">{COLLAPSE_ICON[side].open}</span>
            </button>

            <div
                className={`dock__body${dropping ? ' is-dropping' : ''}`}
                ref={bodyRef}
                onScroll={onBodyScroll}
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
                    if (!id) return;
                    // Everything between the sections is dock body too: the gaps,
                    // the padding, and the space under the last panel. Appending
                    // for all of it meant a drop that missed a section by three
                    // pixels went to the bottom instead of where it was aimed, so
                    // the nearest section decides — and only an empty dock, or a
                    // drop below every panel in it, actually appends.
                    const near = nearestSection(e.clientX, e.clientY);
                    if (near) movePanelNear(id, side, near.id, near.edge);
                    else movePanel(id, side, null);
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
                            // The neighbours the header's reorder arrows step
                            // to. Visible ones: a panel that is hidden, or that
                            // does not apply here, is not somewhere the arrow
                            // can appear to move this one past.
                            prev={visible[i - 1]}
                            next={visible[i + 1]}
                            weight={side === 'bottom' ? shareOf(weights, id) : undefined}
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

    if (dock.collapsed) {
        return (
            <div
                className={`dock dock--${side} is-collapsed`}
                onPointerLeave={endPeek}
            >
                <button
                    type="button"
                    className="dock__rail"
                    onClick={() => { endPeek(); toggleDock(side); }}
                    onPointerEnter={startPeek}
                    title={`Show ${side} panels`}
                >
                    <span className="dock__rail-icon">{COLLAPSE_ICON[side].closed}</span>
                    <span className="dock__rail-label">
                        {visible.map((id) => PANEL_BY_ID[id].title).join(' · ') || 'Panels'}
                    </span>
                </button>
                {peeking && expanded({
                    className: ' dock--peek',
                    // Entering the overlay keeps it open — the pointer has left
                    // the rail by then, and the timer started on that would
                    // otherwise close it under the pointer.
                    props: { onPointerEnter: cancelClose },
                })}
            </div>
        );
    }

    return expanded({});
}
