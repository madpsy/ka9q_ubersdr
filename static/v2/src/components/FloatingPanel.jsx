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

import React from '../react.js';
import { DOCKS, useLayout } from '../layout/LayoutContext.jsx';
import { useFloatDrag } from '../lib/useFloatDrag.js';
import { Icon, Menu, MenuItem } from './ui.jsx';

const DOCK_LABEL = { left: 'left dock', right: 'right dock', bottom: 'bottom dock' };

export default function FloatingPanel({ panel, geom, z, bounds, minimised }) {
    const {
        sections, setFloat, setFloatMin, raiseFloat, movePanel, setSectionHidden, toggleSectionMinimal,
    } = useLayout();
    // Same flag the docked section uses: a panel looks the same wherever it is.
    const minimal = !!panel.minimal && !!sections[panel.id]?.minimal;

    // The size floor lives in LayoutContext (setFloat clamps), so none is
    // passed here — this only has to stop the gesture running away.
    const { onMoveDown, onSizeDown, onMove, onEnd } = useFloatDrag({
        geom,
        bounds,
        onChange: (patch) => setFloat(panel.id, patch),
        onRaise: () => raiseFloat(panel.id),
    });

    return (
        <section
            className={`floatwin${minimised ? ' floatwin--min' : ''}`}
            style={{ left: geom.x, top: geom.y, width: geom.w, height: geom.h, zIndex: 10 + z }}
            /* Hidden, not merely transparent: visibility takes it out of the
               accessibility tree and out of the tab order too, so a window on the
               strip cannot be tabbed into or read out from where it is not. */
            aria-hidden={minimised || undefined}
            onPointerDown={() => raiseFloat(panel.id)}
        >
            <header
                className="floatwin__head"
                onPointerDown={onMoveDown}
                onPointerMove={onMove}
                onPointerUp={onEnd}
                onPointerCancel={onEnd}
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
            <div className="floatwin__body">
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
