// A collapsible panel inside a dock.
//
// The header doubles as the drag handle: dragging it onto another section (or
// onto a dock's empty area) reorders or re-docks the panel. Drag-and-drop uses
// the native HTML5 API so no pointer bookkeeping is needed and the browser
// supplies the drag image for free.

import React, { useCallback, useState } from '../react.js';
import { DOCKS, useLayout } from '../layout/LayoutContext.jsx';
import { Icon, Menu, MenuItem } from './ui.jsx';
import { useDragEndReset } from '../lib/useDragEnd.js';

const DOCK_LABEL = { left: 'left dock', right: 'right dock', bottom: 'bottom dock' };

export default function Section({ panel, dock, index, weight }) {
    const { sections, toggleSection, setSectionHidden, movePanel } = useLayout();
    const [dropEdge, setDropEdge] = useState(null);   // 'before' | 'after' | null

    // Same reason as the dock: a drop landing elsewhere must still clear this
    // section's insertion marker.
    const clearEdge = useCallback(() => setDropEdge(null), []);
    useDragEndReset(dropEdge !== null, clearEdge);
    const state = sections[panel.id] || { open: true };

    const onDragStart = (e) => {
        e.dataTransfer.setData('text/ubersdr-panel', panel.id);
        e.dataTransfer.effectAllowed = 'move';
    };

    const onDragOver = (e) => {
        if (!e.dataTransfer.types.includes('text/ubersdr-panel')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const r = e.currentTarget.getBoundingClientRect();
        const vertical = dock !== 'bottom';
        const mid = vertical ? r.top + r.height / 2 : r.left + r.width / 2;
        const pos = vertical ? e.clientY : e.clientX;
        setDropEdge(pos < mid ? 'before' : 'after');
    };

    const onDrop = (e) => {
        const id = e.dataTransfer.getData('text/ubersdr-panel');
        setDropEdge(null);
        if (!id || id === panel.id) return;
        e.preventDefault();
        // Deliberately not stopPropagation: the dock needs to see the drop to
        // clear its own hover tint. Marking the event tells it the placement is
        // already decided. (React reuses one synthetic event along the path, so
        // the flag survives the bubble.)
        e.panelDropHandled = true;
        movePanel(id, dock, dropEdge === 'after' ? index + 1 : index);
    };

    const cls = [
        'section',
        state.open ? 'is-open' : 'is-closed',
        panel.fill && state.open ? 'section--fill' : '',
        dropEdge ? `is-drop-${dropEdge}` : '',
    ].filter(Boolean).join(' ');

    // In the bottom dock the panels share one row, so their width is a weight
    // the user can drag rather than a fixed basis.
    const style = weight != null && state.open
        ? { flexGrow: weight, flexShrink: 1, flexBasis: 0 }
        : undefined;

    return (
        <section
            className={cls}
            style={style}
            onDragOver={onDragOver}
            onDragLeave={() => setDropEdge(null)}
            onDrop={onDrop}
        >
            <header
                className="section__head"
                draggable
                onDragStart={onDragStart}
                onDragEnd={() => setDropEdge(null)}
            >
                <button
                    type="button"
                    className="section__toggle"
                    aria-expanded={state.open}
                    onClick={() => toggleSection(panel.id)}
                >
                    <span className="section__chevron"><Icon.Chevron size={14} /></span>
                    <span className="section__icon">{panel.icon}</span>
                    <span className="section__title">{panel.title}</span>
                    {panel.Badge && <panel.Badge />}
                </button>

                <Menu trigger={<span className="section__grip" title="Move panel"><Icon.Drag size={14} /></span>}>
                    {DOCKS.filter((d) => d !== dock).map((d) => (
                        <MenuItem key={d} onClick={() => movePanel(panel.id, d, null)}>
                            Move to {DOCK_LABEL[d]}
                        </MenuItem>
                    ))}
                    <MenuItem onClick={() => movePanel(panel.id, 'float', null)}>Float</MenuItem>
                    <MenuItem onClick={() => setSectionHidden(panel.id, true)}>Hide panel</MenuItem>
                </Menu>
            </header>

            {state.open && (
                <div className="section__body">
                    <panel.Component />
                </div>
            )}
        </section>
    );
}
