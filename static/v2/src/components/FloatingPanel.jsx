// A panel detached from the docks: a small window that can be dragged and
// resized anywhere over the centre area.
//
// The panel body is unchanged — same component as in a dock. Only the chrome
// differs, which is the whole point of the registry: placement is data.

import React, { useCallback, useRef } from '../react.js';
import { DOCKS, useLayout } from '../layout/LayoutContext.jsx';
import { Icon, Menu, MenuItem } from './ui.jsx';

const DOCK_LABEL = { left: 'left dock', right: 'right dock', bottom: 'bottom dock' };
const EDGE_KEEP = 60;   // px of the window that must stay reachable on screen

export default function FloatingPanel({ panel, geom, z, bounds }) {
    const { setFloat, raiseFloat, movePanel, setSectionHidden } = useLayout();
    const drag = useRef(null);

    // Both dragging and resizing run through one pointer handler; `mode` says
    // whether the pointer delta moves the window or grows it. The pointer
    // origin is deliberately named apart from the geometry — spreading `geom`
    // over `{x, y}` would silently overwrite it and make the window jump to the
    // cursor on the first move.
    const start = useCallback((e, mode) => {
        // A press that begins on a title-bar control must not start a drag.
        // preventDefault() here would suppress the compatibility mouse events
        // the button's click depends on, and setPointerCapture() would redirect
        // the rest of the gesture to the header — between them the menu never
        // opens and the close button never fires.
        if (mode === 'move' && e.target && e.target.closest && e.target.closest('.floatwin__ctl')) return;
        e.preventDefault();
        e.stopPropagation();
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        raiseFloat(panel.id);
        drag.current = { mode, px: e.clientX, py: e.clientY, ...geom };
    }, [geom, panel.id, raiseFloat]);

    const move = useCallback((e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.px;
        const dy = e.clientY - d.py;
        const max = bounds.current;
        if (d.mode === 'move') {
            // Clamp so a window can never be dragged fully out of reach.
            setFloat(panel.id, {
                x: Math.max(EDGE_KEEP - d.w, Math.min((max ? max.width : Infinity) - EDGE_KEEP, d.x + dx)),
                y: Math.max(0, Math.min((max ? max.height : Infinity) - 28, d.y + dy)),
            });
        } else {
            setFloat(panel.id, { w: d.w + dx, h: d.h + dy });
        }
    }, [panel.id, setFloat, bounds]);

    const end = useCallback((e) => {
        drag.current = null;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }, []);

    const onMoveDown = (e) => start(e, 'move');
    const onSizeDown = (e) => start(e, 'size');

    return (
        <section
            className="floatwin"
            style={{ left: geom.x, top: geom.y, width: geom.w, height: geom.h, zIndex: 10 + z }}
            onPointerDown={() => raiseFloat(panel.id)}
        >
            <header
                className="floatwin__head"
                onPointerDown={onMoveDown}
                onPointerMove={move}
                onPointerUp={end}
                onPointerCancel={end}
                onDoubleClick={() => movePanel(panel.id, panel.dock, null)}
            >
                <span className="floatwin__icon">{panel.icon}</span>
                <span className="floatwin__title">{panel.title}</span>
                <Menu trigger={<span className="floatwin__btn floatwin__ctl" title="Panel options"><Icon.Drag size={14} /></span>}>
                    {DOCKS.map((d) => (
                        <MenuItem key={d} onClick={() => movePanel(panel.id, d, null)}>
                            Dock to {DOCK_LABEL[d]}
                        </MenuItem>
                    ))}
                    <MenuItem onClick={() => setSectionHidden(panel.id, true)}>Hide panel</MenuItem>
                </Menu>
                <button
                    type="button"
                    className="floatwin__btn floatwin__ctl"
                    title="Return to its dock"
                    onClick={() => movePanel(panel.id, panel.dock, null)}
                >
                    <Icon.Close size={14} />
                </button>
            </header>

            {/* The window has a fixed height, so its body is a scroller — the
                same rule as the mobile sheet: containers scroll, panels do not. */}
            <div className="floatwin__body">
                <panel.Component />
            </div>

            <span
                className="floatwin__grip"
                title="Resize"
                onPointerDown={onSizeDown}
                onPointerMove={move}
                onPointerUp={end}
                onPointerCancel={end}
            />
        </section>
    );
}
