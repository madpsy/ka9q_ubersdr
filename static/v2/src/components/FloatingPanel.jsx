// A panel detached from the docks: a small window that can be dragged and
// resized anywhere over the centre area.
//
// The panel body is unchanged — same component as in a dock. Only the chrome
// differs, which is the whole point of the registry: placement is data.
//
// `minimised` is a window put away on the strip along the bottom, and it is drawn
// rather than dropped: the panel stays mounted at its full size and is only made
// invisible. That is the difference between minimising and collapsing, and it is
// a real one — collapsing a dock section unmounts the panel, which is how the DX
// cluster panel drops its login and how a decoder stops decoding, and minimising
// must not do that. Somebody putting a window out of the way for a minute has not
// asked to be logged out of a cluster. Same treatment ExtensionWindow gives a
// minimised extension, for the same reason.

import React, { useEffect, useRef } from '../react.js';
import { DOCKS, UNHIDEABLE, useLayout } from '../layout/LayoutContext.jsx';
import { useFloatDrag } from '../lib/useFloatDrag.js';
import { dockBodyAt, nearestPanelGap } from '../lib/panelDrag.js';
import { Icon, Menu, MenuItem } from './ui.jsx';
import useWakeProps from '../radio/useWake.js';
import PanelZoom, { usePanelScale } from './PanelZoom.jsx';
import { useHeaderFits } from '../lib/useHeaderFits.js';
import { fitX, fitY } from '../lib/fitOnScreen.js';
import { useViewport } from '../lib/useViewport.js';

// What the pair costs this bar: two 22px buttons and the gap in front of them.
// Wider than the docked header's, because a window's controls are — see
// .floatwin__btn.
const ZOOM_W = 50;

const DOCK_LABEL = { left: 'left dock', right: 'right dock', bottom: 'bottom dock' };

export default function FloatingPanel({ panel, geom, z, bounds, minimised }) {
    const {
        sections, setFloat, setFloatMin, raiseFloat, movePanel, movePanelNear,
        setSectionHidden, toggleSectionMinimal,
    } = useLayout();
    // Same flag the docked section uses: a panel looks the same wherever it is.
    const minimal = !!panel.minimal && !!sections[panel.id]?.minimal;
    // The body only, as in a docked section: raising, moving and resizing the
    // window are not reasons to open a session. See radio/useWake.js.
    const wake = useWakeProps();

    // The size floor lives in LayoutContext (setFloat clamps), so none is
    // passed here — this only has to stop the gesture running away.
    const zoom = usePanelScale(panel.id);
    // The header itself this time: its title is the elastic child and every
    // other child is a fixed-width button, which is exactly the shape
    // measureSlack asks for. A dock section needs its title *button* instead —
    // see the note there.
    // Where it is drawn, which is where it was put unless the page has since
    // got smaller — see lib/fitOnScreen.js. The stored geometry is untouched,
    // so a window pulled up by a keyboard goes back down when the keyboard
    // does.
    const viewport = useViewport();
    const drawX = fitX(geom.x, geom.w, viewport.w);
    const drawY = fitY(geom.y, geom.h, viewport.h);

    const head = useRef(null);
    const roomToZoom = useHeaderFits(head, '.floatwin__title', ZOOM_W);
    const { onMoveDown, onSizeDown, onMove, onEnd } = useFloatDrag({
        // The drawn position, not the stored one: a window the viewport has
        // pulled up is *there*, and a drag that began from where it is not
        // would jump under the finger by however far it had been pulled.
        // Dragging then writes that position down, which is right — a drag is
        // somebody placing the window, whatever moved it beforehand.
        geom: { ...geom, x: drawX, y: drawY },
        bounds,
        onChange: (patch) => setFloat(panel.id, patch),
        onRaise: () => raiseFloat(panel.id),
    });

    // Carrying a floating window back into a dock.
    //
    // The docks accept a *browser* drag — a panel's header in a dock is
    // `draggable`, and the dock body answers dragover/drop (components/Dock.jsx).
    // A floating window cannot join in: it is moved by a pointer capture, and
    // making the same header `draggable` as well would start both gestures on
    // one press, cost the live movement and leave the window behind a drag
    // image. So the window keeps its own gesture and this watches where the
    // pointer is while it runs.
    //
    // The highlight is written to the dock's element rather than through React:
    // it changes at pointer rate, `is-dropping` is the class the dock already
    // styles for exactly this, and re-rendering three docks per pointer move to
    // set a class is the one cost worth avoiding here.
    const moving = useRef(false);
    const target = useRef(null);
    const gap = useRef(null);

    // The marker between two panels, drawn where the window would land.
    //
    // The same two classes the dock's own drag paints (components/Section.jsx
    // sets them from `dropEdge`), on the same elements, so the two gestures
    // promise the same thing in the same way — a drop that lands somewhere
    // other than where the line was is the one failure this cannot have.
    const clearGap = () => {
        if (gap.current) gap.current.classList.remove('is-drop-before', 'is-drop-after');
        gap.current = null;
    };

    const showGap = (body, side, clientX, clientY) => {
        const at = nearestPanelGap(body, clientX, clientY, side, panel.id);
        const el = at ? body.querySelector(`[data-panel="${at.id}"]`) : null;
        if (el === gap.current && (!at || el.classList.contains(`is-drop-${at.edge}`))) return at;
        clearGap();
        if (el) {
            el.classList.add(`is-drop-${at.edge}`);
            gap.current = el;
        }
        return at;
    };

    const clearTarget = () => {
        if (target.current) target.current.el.classList.remove('is-dropping');
        target.current = null;
        clearGap();
    };

    const startMove = (e) => {
        moving.current = true;
        onMoveDown(e);
    };

    const trackMove = (e) => {
        onMove(e);
        if (!moving.current) return;
        // The pointer, not the window: the window stops at the edge of the
        // floating layer (useFloatDrag keeps it on screen), so its own position
        // never reaches a dock even when the hand carrying it does.
        const found = dockBodyAt(e.clientX, e.clientY);
        if ((found && found.el) !== (target.current && target.current.el)) {
            clearTarget();
            if (found) {
                found.el.classList.add('is-dropping');
                target.current = found;
            }
        }
        // Within the dock the pointer is over, which gap. Recomputed on every
        // move rather than only on entering the dock: the whole point is that
        // sliding up and down the dock chooses where it goes.
        if (found) showGap(found.el, found.side, e.clientX, e.clientY);
    };

    const endMove = (e) => {
        const found = target.current;
        const wasMoving = moving.current;
        moving.current = false;
        clearTarget();
        onEnd(e);
        if (!wasMoving || !found) return;
        // Where the marker would have been, by the same rule a drag between two
        // docks follows.
        const at = nearestPanelGap(found.el, e.clientX, e.clientY, found.side, panel.id);
        if (at) movePanelNear(panel.id, found.side, at.id, at.edge);
        else movePanel(panel.id, found.side, null);
    };

    // A gesture cut short — the pointer lost, the window unmounted — must not
    // leave a dock lit up with nothing being dragged into it.
    useEffect(() => clearTarget, []);

    return (
        <section
            className={`floatwin${minimised ? ' floatwin--min' : ''}`}
            style={{ left: drawX, top: drawY, width: geom.w, height: geom.h, zIndex: 10 + z, ...zoom.style }}
            /* Hidden, not merely transparent: visibility takes it out of the
               accessibility tree and out of the tab order too, so a window on the
               strip cannot be tabbed into or read out from where it is not. */
            aria-hidden={minimised || undefined}
            onPointerDown={() => raiseFloat(panel.id)}
        >
            <header
                className="floatwin__head"
                ref={head}
                onPointerDown={startMove}
                onPointerMove={trackMove}
                onPointerUp={endMove}
                onPointerCancel={endMove}
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
                    {/* Not offered for the Layout panel, which is the one that brings
                        hidden panels back — see UNHIDEABLE. The context refuses it
                        anyway; leaving the item here would be a control that does
                        nothing. */}
                    {panel.id !== UNHIDEABLE && (
                        <MenuItem onClick={() => setSectionHidden(panel.id, true)}>Hide panel</MenuItem>
                    )}
                </Menu>
                {/* Text size for this window alone — see PanelZoom. First out
                    when the window is dragged too narrow to carry the row, which
                    is the one control here with the same job available elsewhere:
                    the top bar zooms the lot. */}
                {roomToZoom && (
                    <PanelZoom panelId={panel.id} className="floatwin__btn floatwin__ctl" />
                )}
                {panel.minimal && (
                    <button
                        type="button"
                        className="floatwin__btn floatwin__ctl"
                        title={minimal ? 'Show the full panel' : 'Show the minimal view'}
                        aria-pressed={minimal}
                        onClick={() => toggleSectionMinimal(panel.id)}
                    >
                        {minimal ? <Icon.Expand size={13} /> : <Icon.Collapse size={13} />}
                    </button>
                )}
                <button
                    type="button"
                    className="floatwin__btn floatwin__ctl"
                    title="Minimise to the strip along the bottom"
                    onClick={() => setFloatMin(panel.id, true)}
                >
                    <Icon.Minus size={14} />
                </button>
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
            <div className="floatwin__body" {...wake}>
                <panel.Component minimal={minimal} />
            </div>

            <span
                className="floatwin__grip"
                title="Resize"
                onPointerDown={onSizeDown}
                onPointerMove={onMove}
                onPointerUp={onEnd}
                onPointerCancel={onEnd}
            />
        </section>
    );
}
