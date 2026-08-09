// A collapsible panel inside a dock.
//
// The header doubles as the drag handle: dragging it onto another section (or
// onto a dock's empty area) reorders or re-docks the panel. Drag-and-drop uses
// the native HTML5 API so no pointer bookkeeping is needed and the browser
// supplies the drag image for free.

import React, { useRef } from '../react.js';
import { DOCKS, UNHIDEABLE, useLayout } from '../layout/LayoutContext.jsx';
import { Icon, Menu, MenuItem } from './ui.jsx';
import { setDraggingPanel } from '../lib/panelDrag.js';
import useWakeProps from '../radio/useWake.js';
import PanelZoom, { usePanelScale } from './PanelZoom.jsx';
import { useHeaderFits } from '../lib/useHeaderFits.js';

// What the zoom pair costs the header: two 17px buttons and the gap in front of
// them. Compared against the slack actually left in the bar, so it is the only
// figure needed — no threshold on the panel, which cannot know how long this
// panel's title is or how many other controls this header is carrying.
const ZOOM_W = 38;

const DOCK_LABEL = { left: 'left dock', right: 'right dock', bottom: 'bottom dock' };

// Snap step for in-dock resizing. Fine enough to feel free-form, coarse enough
// that neighbouring panels line up instead of being a pixel out.
const SNAP = 8;
const snap = (v) => Math.round(v / SNAP) * SNAP;

export default function Section({ panel, dock, index, weight, height, prev, next, dropEdge }) {
    const {
        sections, toggleSection, toggleSectionMinimal, setSectionHidden, movePanel, swapPanels,
        weights, setWeights, setPanelHeight,
    } = useLayout();
    const grip = useRef(null);
    // The title button, not the header: the button is `flex: 1` and would have
    // swallowed the slack being asked about, so the question is put to the row
    // inside it — chevron, icon, title, badge — where nothing grows. See
    // lib/headerRoom.js.
    const head = useRef(null);
    const roomToZoom = useHeaderFits(head, '.section__title', ZOOM_W);
    const zoom = usePanelScale(panel.id);
    // On the body, not the whole section: the header is where you collapse a
    // panel and move it about, which is housekeeping and not a reason to open a
    // session. See radio/useWake.js.
    const wake = useWakeProps();
    const state = sections[panel.id] || { open: true };
    const minimal = !!panel.minimal && !!state.minimal;
    // The bottom dock is a row; the side docks are columns.
    const row = dock === 'bottom';

    // The drag itself. Where it may land is worked out by the dock, which is
    // the only element that sees the gaps between sections as well as the
    // sections: a drop is aimed at a gap, and half the gaps are not over any
    // panel at all. `dropEdge` arrives as a prop from there, and the dock does
    // the placing on drop.
    const onDragStart = (e) => {
        e.dataTransfer.setData('text/ubersdr-panel', panel.id);
        e.dataTransfer.effectAllowed = 'move';
        // Read by the dock during dragover, where dataTransfer will not say.
        setDraggingPanel(panel.id);
    };

    const cls = [
        'section',
        state.open ? 'is-open' : 'is-closed',
        panel.fill && state.open ? 'section--fill' : '',
        dropEdge ? `is-drop-${dropEdge}` : '',
    ].filter(Boolean).join(' ');

    // In the bottom dock the panels share one row, so their width is a weight
    // the user can drag rather than a fixed basis, and each may carry its own
    // height.
    const inRow = weight != null && state.open;
    // The panel's own text size rides along with whatever the placement asks for
    // — one style object, because an element has one.
    const style = inRow
        ? { flexGrow: weight, flexShrink: 1, flexBasis: 0, ...(height ? { height, alignSelf: 'flex-start' } : {}), ...zoom.style }
        : zoom.style;

    // Corner grip: horizontal drag trades width with a neighbour (so the row's
    // total is unchanged, as with the splitters), vertical sets this panel's
    // own height. Same affordance as a floating window.
    const onGripDown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Guarded, as every other setPointerCapture in the app is: it throws if
        // the pointer is no longer active, and it was the first statement of the
        // gesture — so a throw took the rest of the handler with it and the drag
        // never started at all, silently. The capture is what keeps a drag alive
        // once the finger leaves this 26px corner, which is most of a drag.
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        const me = e.currentTarget.parentElement;
        const sibling = me.nextElementSibling?.nextElementSibling || me.previousElementSibling?.previousElementSibling;
        grip.current = {
            x: e.clientX,
            y: e.clientY,
            h: me.getBoundingClientRect().height,
            mw: me.getBoundingClientRect().width,
            sw: sibling ? sibling.getBoundingClientRect().width : 0,
            other: sibling ? sibling.dataset.panel : null,
            // Which side the partner is on decides the sign of the trade.
            after: !!me.nextElementSibling?.nextElementSibling,
        };
    };

    const onGripMove = (e) => {
        const g = grip.current;
        if (!g) return;
        setPanelHeight(panel.id, snap(g.h + (e.clientY - g.y)));
        if (!g.other) return;
        const total = g.mw + g.sw;
        const MIN = 140;
        const dx = (g.after ? 1 : -1) * (e.clientX - g.x);
        const mine = Math.max(MIN, Math.min(total - MIN, snap(g.mw + dx)));
        const sum = (weights[panel.id] || 1) + (weights[g.other] || 1);
        const w = (mine / total) * sum;
        setWeights([[panel.id, w], [g.other, sum - w]]);
    };

    const onGripUp = (e) => {
        grip.current = null;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    };

    return (
        <section
            className={cls}
            style={style}
            data-panel={panel.id}
        >
            <header
                className="section__head"
                draggable
                onDragStart={onDragStart}
                onDragEnd={() => setDraggingPanel(null)}
            >
                <button
                    type="button"
                    className="section__toggle"
                    aria-expanded={state.open}
                    onClick={() => toggleSection(panel.id)}
                    ref={head}
                >
                    <span className="section__chevron"><Icon.Chevron size={14} /></span>
                    <span className="section__icon">{panel.icon}</span>
                    <span className="section__title">{panel.title}</span>
                    {panel.Badge && <panel.Badge />}
                </button>

                {/* Reordering without a drag. Dragging the header does the same
                    job and is the quicker way over a long distance, but it is
                    fiddly in a 220px dock and there is nothing about a header
                    that says it can be dragged — an arrow says it plainly. The
                    bottom dock lays its panels out in a row, so there the two
                    steps are left and right rather than up and down.

                    Docked only: a floating window has no order to step through,
                    and this header is never drawn for one. */}
                {(prev || next) && (
                    <span className="section__order">
                        <button
                            type="button"
                            className="section__grip section__arrow"
                            disabled={!prev}
                            title={row ? 'Move panel left' : 'Move panel up'}
                            onClick={() => swapPanels(panel.id, prev)}
                        >
                            {row ? <Icon.ChevronLeft size={13} /> : <Icon.ChevronUp size={13} />}
                        </button>
                        <button
                            type="button"
                            className="section__grip section__arrow"
                            disabled={!next}
                            title={row ? 'Move panel right' : 'Move panel down'}
                            onClick={() => swapPanels(panel.id, next)}
                        >
                            {row ? <Icon.ChevronRight size={13} /> : <Icon.Chevron size={13} />}
                        </button>
                    </span>
                )}

                {/* Text size for this panel alone, on top of the global one in
                    the top bar. Open panels only, as with the minimal toggle:
                    the size of a collapsed panel is the size of its own title.

                    First out when the title bar runs out of room — see ZOOM_W.
                    Of the controls in this header it is the one
                    with somewhere else to go: the same job is done for the whole
                    interface from the top bar, whereas the move menu and the
                    minimal toggle exist only here. */}
                {state.open && roomToZoom && (
                    <PanelZoom panelId={panel.id} className="section__grip section__arrow" />
                )}

                {/* Only for panels that declare one, and only while open —
                    there is nothing to cut down in a collapsed section. */}
                {panel.minimal && state.open && (
                    <button
                        type="button"
                        className="section__grip"
                        title={minimal ? 'Show the full panel' : 'Show the minimal view'}
                        aria-pressed={minimal}
                        onClick={() => toggleSectionMinimal(panel.id)}
                    >
                        {minimal ? <Icon.Expand size={13} /> : <Icon.Collapse size={13} />}
                    </button>
                )}

                <Menu trigger={<span className="section__grip" title="Move panel"><Icon.Drag size={14} /></span>}>
                    {DOCKS.filter((d) => d !== dock).map((d) => (
                        <MenuItem key={d} onClick={() => movePanel(panel.id, d, null)}>
                            Move to {DOCK_LABEL[d]}
                        </MenuItem>
                    ))}
                    <MenuItem onClick={() => movePanel(panel.id, 'float', null)}>Float</MenuItem>
                    {/* Not offered for the Layout panel, which is the one that brings
                        hidden panels back — see UNHIDEABLE. The context refuses it
                        anyway; leaving the item here would be a control that does
                        nothing. */}
                    {panel.id !== UNHIDEABLE && (
                        <MenuItem onClick={() => setSectionHidden(panel.id, true)}>Hide panel</MenuItem>
                    )}
                </Menu>
            </header>

            {state.open && (
                <div className="section__body" {...wake}>
                    <panel.Component minimal={minimal} />
                </div>
            )}

            {inRow && (
                <span
                    className="section__grip-size"
                    title="Drag to resize — double-click for automatic height"
                    onPointerDown={onGripDown}
                    onPointerMove={onGripMove}
                    onPointerUp={onGripUp}
                    onPointerCancel={onGripUp}
                    onDoubleClick={() => setPanelHeight(panel.id, null)}
                />
            )}
        </section>
    );
}
