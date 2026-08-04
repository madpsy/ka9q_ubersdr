// The open extension, as a window over the centre area.
//
// Extensions float and only float. A decoder is a workspace — a table of
// decodes, a spectrum, an image — not a strip of controls, so it does not fit a
// dock's column, and it is transient in a way panels are not: you open it, work
// with it, and close it. That also keeps the dock layout stable, since an
// extension never joins the saved panel arrangement.
//
// There is only ever one, so this renders the active extension or nothing.
// Closing is the only chrome besides the drag and resize handles: no dock menu,
// no hide, because there is nowhere else for it to go.

import React, { useEffect } from '../react.js';
import { useFloatDrag } from '../lib/useFloatDrag.js';
import { Icon } from '../components/ui.jsx';
import { useExtensions } from './ExtensionsContext.jsx';

const MIN = { w: 380, h: 240 };

export default function ExtensionWindow({ bounds }) {
    const {
        active, close, minimised, setMinimised, geometryOf, setFloat, minimalOf, toggleMinimal,
    } = useExtensions();
    const geom = geometryOf(active ? active.id : '');
    const minimal = minimalOf(active ? active.id : '');

    const { onMoveDown, onSizeDown, onMove, onEnd } = useFloatDrag({
        geom,
        bounds,
        min: MIN,
        onChange: (patch) => { if (active) setFloat(active.id, patch); },
    });

    // A window sized for a desktop, or left where a wider viewport put it, must
    // still be reachable here: fit it to the layer and pull it back into view.
    // The layer re-renders this on resize, which is what makes the check run.
    useEffect(() => {
        const b = bounds && bounds.current;
        // Not before the layer has a real size — clamping against an unmeasured
        // one would rewrite the stored position to the corner, and persist it.
        if (!active || !b || b.width < 120 || b.height < 120) return;
        const w = Math.max(MIN.w, Math.min(geom.w, b.width));
        const h = Math.max(MIN.h, Math.min(geom.h, b.height));
        const x = Math.max(0, Math.min(b.width - w, geom.x));
        const y = Math.max(0, Math.min(Math.max(0, b.height - h), geom.y));
        if (w !== geom.w || h !== geom.h || x !== geom.x || y !== geom.y) {
            setFloat(active.id, { x, y, w, h });
        }
    });

    if (!active) return null;

    return (
        // Minimised keeps the window in the tree at its full size and only stops
        // it being painted, so the decoder runs on and every canvas keeps the
        // dimensions it was measured at — restoring is instant and lossless.
        <section
            className={`floatwin floatwin--ext${minimised ? ' floatwin--min' : ''}`}
            style={{ left: geom.x, top: geom.y, width: geom.w, height: geom.h }}
            aria-label={active.title}
            aria-hidden={minimised || undefined}
        >
            <header
                className="floatwin__head"
                onPointerDown={onMoveDown}
                onPointerMove={onMove}
                onPointerUp={onEnd}
                onPointerCancel={onEnd}
            >
                <span className="floatwin__icon">{active.icon}</span>
                <span className="floatwin__title">{active.title}</span>
                {/* The same control a docked or floating panel gets, in the
                    same place and with the same icons — see FloatingPanel. */}
                {active.minimal && (
                    <button
                        type="button"
                        className="floatwin__btn floatwin__ctl"
                        title={minimal ? 'Show the full extension' : 'Show the minimal view'}
                        aria-pressed={minimal}
                        onClick={() => toggleMinimal(active.id)}
                    >
                        {minimal ? <Icon.Expand size={13} /> : <Icon.Collapse size={13} />}
                    </button>
                )}
                <button
                    type="button"
                    className="floatwin__btn floatwin__ctl"
                    title="Minimise — the decoder keeps running"
                    onClick={() => setMinimised(true)}
                >
                    <Icon.Minus size={14} />
                </button>
                <button
                    type="button"
                    className="floatwin__btn floatwin__ctl"
                    title="Close this extension"
                    onClick={close}
                >
                    <Icon.Close size={14} />
                </button>
            </header>

            {/* Unlike a panel, an extension lays itself out: its body is a flex
                column that does not scroll, so a decoder can give its own table
                or image the leftover height and scroll that instead. */}
            <div className="floatwin__body floatwin__body--ext">
                <active.Component minimal={minimal} />
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
