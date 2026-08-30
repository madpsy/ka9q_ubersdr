// A dock: an ordered, resizable, collapsible column (or, for `bottom`, a row)
// of sections. Also the drop target for panels dragged past the last section.

import React, { useCallback, useEffect, useRef, useState } from '../react.js';
import { useLayout } from '../layout/LayoutContext.jsx';
import { noteDockFocus, restoreDockFocus } from '../lib/dockFocus.js';
import { useDisplay } from '../display/DisplayContext.jsx';
import { HOVER_QUERY, useMediaQuery } from '../lib/useMediaQuery.js';
import { PANEL_BY_ID, usePanelApplies } from '../panels/registry.jsx';
import Section from './Section.jsx';
import { Icon } from './ui.jsx';
import { useDragEndReset } from '../lib/useDragEnd.js';
import { draggingPanel, nearestPanelGap } from '../lib/panelDrag.js';
import { columnOf, dockCeiling, fitDock } from '../lib/dockSize.js';

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

// The column the bottom dock shares with the spectrum, and how tall it may be
// made in it. Climbed to rather than taken as the parent: a peeked dock is an
// overlay rendered *inside* the collapsed rail, so its parent is a 30px strip
// and not the column it is drawn over. Reading the parent capped the peek at the
// dock's 120px floor and left its resizer unable to move it, which is the whole
// reason the ceiling is measured here and not asked of CSS — see lib/dockSize.js.
//
// Only the bottom dock: the side docks are bounded by their own minSize/maxSize,
// and a window narrow enough for that to matter has the mobile shell.
function useDockCeiling(rootRef, side, minSize, collapsed) {
    const [ceiling, setCeiling] = useState(Infinity);

    useEffect(() => {
        if (side !== 'bottom') return undefined;
        const column = columnOf(rootRef.current);
        if (!column) return undefined;
        const measure = () => setCeiling(dockCeiling(column.clientHeight, minSize));
        measure();
        // The column's height is the shell's, not the dock's — it is stretched
        // by .shell__main and does not move when the dock inside it is resized
        // — so watching it cannot feed back into itself.
        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', measure);
            return () => window.removeEventListener('resize', measure);
        }
        const ro = new ResizeObserver(measure);
        ro.observe(column);
        return () => ro.disconnect();
        // `collapsed` swaps which element carries the ref, so the column has to
        // be found again — it is the same one, but the ref it is climbed from
        // has been remounted.
    }, [rootRef, side, minSize, collapsed]);

    return ceiling;
}

// Drag handle between two bottom-dock panels. Converts a pixel delta into a
// share of the pair's combined width, so the rest of the row is undisturbed.
function SectionSplitter({ before, after, weights, setWeights }) {
    const drag = useRef(null);

    const onDown = (e) => {
        e.preventDefault();
        // Same guard as the dock resizer's, for the same reason.
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
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
    // Where the panel would land: { id, edge }, the gap next to a section. Held
    // here rather than in each section because half the gaps are not over a
    // section at all — the space between two of them, the padding, the room
    // under the last one — and a marker that only appears over a panel is a
    // marker you have to hunt for.
    const [dropAt, setDropAt] = useState(null);
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
    // panel would open and instantly close again. The same test decides whether
    // the top bar offers the setting at all — see HOVER_QUERY.
    const canHover = useMediaQuery(HOVER_QUERY);
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

    // The dock's outermost element, which is all the ceiling needs: it climbs
    // from there to the column. On the outer element rather than the peek
    // overlay so it survives a peek opening and closing, the same reason the
    // scroll offset above is kept here.
    const rootEl = useRef(null);
    const ceiling = useDockCeiling(rootEl, side, dock.minSize, dock.collapsed);

    const bodyRef = useCallback((el) => {
        bodyEl.current = el;
        if (!el) return;
        el.scrollTop = scrollAt.current.top;
        el.scrollLeft = scrollAt.current.left;
        echo.current = { top: el.scrollTop, left: el.scrollLeft };
        // ...and the keyboard, to whichever panel in here had it last. Same reasoning as
        // the scroll above: a peek is a fresh mount, so anything that was focused is
        // gone and something has to put it back. See lib/dockFocus.js — restoring is
        // careful about not stealing focus from outside the dock.
        restoreDockFocus(side, el);
    }, [side]);

    // Where the keyboard is, whenever it lands in this dock. A listener rather than a
    // note taken at the moment the dock hides: focus can leave for a dozen reasons and
    // only one of them is this dock closing, and recording it as it arrives cannot miss.
    const onBodyFocus = useCallback((e) => noteDockFocus(side, e.target), [side]);

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
    const clearDropping = useCallback(() => {
        setDropping(false);
        setDropAt(null);
    }, []);
    useDragEndReset(dropping || dropAt !== null, clearDropping);

    const visible = dock.panels.filter((id) => {
        const p = PANEL_BY_ID[id];
        if (!p || sections[id]?.hidden) return false;
        // A panel that does not apply to this server is not merely hidden — it
        // is absent, so it never shows an empty slot or a "not available" note.
        return applies(p);
    });

    const onResizeDown = useCallback((e) => {
        e.preventDefault();
        // Guarded, as the release below already is: capture throws if the
        // pointer is no longer active, and it sat in front of the line that
        // actually starts the drag — so a throw left the gesture dead with
        // nothing said. The capture is what keeps the drag alive once the finger
        // has left an 18px strip, which is immediately.
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        resizeRef.current = {
            start: side === 'bottom' ? e.clientY : e.clientX,
            // What is on screen, which on a window the dock no longer fits is
            // shorter than what is stored: starting from the stored figure
            // would snap the dock back to its full height on the first pixel of
            // a drag that was trying to make it smaller.
            size: fitDock(dock.size, ceiling),
            max: ceiling,
        };
    }, [dock.size, ceiling, side]);

    const onResizeMove = useCallback((e) => {
        const r = resizeRef.current;
        if (!r) return;
        // Left dock grows rightwards; right and bottom grow the other way.
        const delta = side === 'left'
            ? e.clientX - r.start
            : side === 'right'
                ? r.start - e.clientX
                : r.start - e.clientY;
        setDockSize(side, Math.min(r.max, r.size + delta));
    }, [side, setDockSize]);

    const onResizeUp = useCallback((e) => {
        resizeRef.current = null;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }, []);

    // Which section a pointer is nearest, and which side of it — for a drop that
    // landed in the dock but not on a panel. Measured from the DOM rather than
    // from the layout, because it is answering a question about pixels.
    // The gaps, and which one the pointer is nearest. Shared with the float
    // drag, which drops into these same docks — see lib/panelDrag.js.
    const nearestSection = useCallback(
        (clientX, clientY) => nearestPanelGap(bodyEl.current, clientX, clientY, side, draggingPanel()),
        [side],
    );

    // Computed even while collapsed: the peek overlay is the same markup and
    // needs the same size, and the collapsed rail does not use it.
    const style = side === 'bottom' ? { height: fitDock(dock.size, ceiling) } : { width: dock.size };

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
        <div
            className={`dock dock--${side}${extra.className || ''}`}
            style={style}
            // The collapsed branch below owns the ref while a peek is open: the
            // rail is then the outer element, and one ref cannot be on two.
            ref={dock.collapsed ? undefined : rootEl}
            /* Read by the float drag's hit test, which finds a dock body under
               the pointer and has to know which dock it belongs to — see
               dockBodyAt in lib/panelDrag.js. */
            data-dock={side}
            {...extra.props}
        >
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
                onFocus={onBodyFocus}
                onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes('text/ubersdr-panel')) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    setDropping(true);
                    // Every move, everywhere in the body: the marker follows the
                    // pointer to the nearest gap instead of appearing only when
                    // it happens to be over a panel.
                    setDropAt(nearestSection(e.clientX, e.clientY));
                }}
                onDragLeave={(e) => {
                    // dragleave also fires crossing between children, and
                    // clearing then makes the marker flicker off and on.
                    if (e.currentTarget.contains(e.relatedTarget)) return;
                    setDropping(false);
                    setDropAt(null);
                }}
                onDrop={(e) => {
                    setDropping(false);
                    const at = dropAt;
                    setDropAt(null);
                    e.preventDefault();
                    const id = e.dataTransfer.getData('text/ubersdr-panel');
                    if (!id) return;
                    // Wherever the marker was is where it goes — the same answer
                    // the operator was looking at when they let go.
                    if (at) { movePanelNear(id, side, at.id, at.edge); return; }
                    // No marker means no other panel to sit beside: an empty
                    // dock, or one holding only the panel being dragged.
                    movePanel(id, side, null);
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
                            dropEdge={dropAt && dropAt.id === id ? dropAt.edge : null}
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
                ref={rootEl}
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
