// The caption box: what is being said, over everything else on the page.
//
// v1 called it "Show modal" and it is the one part of the extension that cannot
// be the extension's own window. The point of it is to watch the spectrum, or
// the map, or nothing at all, while still seeing what is being said — so it has
// to stay on screen when the extension window is minimised, which the window
// itself by definition does not.
//
// That is why this renders through a portal into <body> rather than inside the
// panel: minimising sets `visibility: hidden` on the extension window (see
// .floatwin--min), and anything drawn inside it goes with it. Out here it is a
// sibling of the window, positioned against the viewport, and unaffected.
//
// It floats, drags and resizes with the same gesture hook the extension window
// and the floating panels use, so it behaves like every other movable thing in
// v2 rather than like a second implementation of dragging.
//
// Two differences from v1, both deliberate:
//
//   * It stays on screen while it is switched on. v1 removed the box whenever
//     there was no in-progress segment, so it appeared and vanished between
//     overs — which made it impossible to position, and made "is it working?"
//     unanswerable. Here it holds the last line when nothing is being decoded.
//   * It has a close button. v1's could only be dismissed from the extension
//     window, which is the one thing you may well have minimised.

import React, { ReactDOM, useCallback, useEffect, useRef, useState } from '../../react.js';
import { Icon } from '../../components/ui.jsx';
import { useFloatDrag } from '../../lib/useFloatDrag.js';

const STORAGE_KEY = 'ubersdr.v2.stt.caption';

// v1's box was 400 px wide with a 200×50 floor. Wider here because the text is
// proportional rather than monospace and a whole spoken sentence fits on two
// lines at the default size.
const DEFAULT = { w: 460, h: 130 };
const MIN = { w: 200, h: 60 };

function loadGeometry() {
    let saved = null;
    try {
        saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch (e) {
        saved = null;
    }
    const w = Math.max(MIN.w, Number(saved && saved.w) || DEFAULT.w);
    const h = Math.max(MIN.h, Number(saved && saved.h) || DEFAULT.h);
    // Centred the first time, which is where v1 opened it.
    const cx = Math.round((window.innerWidth - w) / 2);
    const cy = Math.round((window.innerHeight - h) / 2);
    const x = saved && Number.isFinite(saved.x) ? saved.x : cx;
    const y = saved && Number.isFinite(saved.y) ? saved.y : cy;
    return { x, y, w, h };
}

export default function Caption({ text, hint, font, onClose }) {
    const [geom, setGeom] = useState(loadGeometry);

    // The viewport is what this is positioned against, so that is what bounds
    // the drag. Kept in a ref of the shape useFloatDrag expects.
    const bounds = useRef({ width: window.innerWidth, height: window.innerHeight });
    useEffect(() => {
        const onResize = () => {
            bounds.current = { width: window.innerWidth, height: window.innerHeight };
            // A box left where a wider window put it — or where a rotated phone
            // did — must still be reachable.
            setGeom((g) => {
                const w = Math.min(g.w, window.innerWidth);
                const h = Math.min(g.h, window.innerHeight);
                const x = Math.max(0, Math.min(window.innerWidth - w, g.x));
                const y = Math.max(0, Math.min(Math.max(0, window.innerHeight - h), g.y));
                return (w === g.w && h === g.h && x === g.x && y === g.y) ? g : { x, y, w, h };
            });
        };
        onResize();
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    useEffect(() => {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(geom)); } catch (e) { /* ignore */ }
    }, [geom]);

    const onChange = useCallback((patch) => setGeom((g) => ({ ...g, ...patch })), []);
    const { onMoveDown, onSizeDown, onMove, onEnd } = useFloatDrag({
        geom, bounds, min: MIN, onChange,
    });

    return ReactDOM.createPortal(
        <div
            className="stt-cap"
            style={{ left: geom.x, top: geom.y, width: geom.w, height: geom.h, fontSize: `${font}px` }}
            role="status"
            aria-live="polite"
            aria-label="Live transcription"
            // The whole box is the drag handle: it has no title bar, because a
            // title bar on a caption is a strip of the screen not showing
            // speech. useFloatDrag skips a press that lands on .floatwin__ctl,
            // which is what leaves the close button clickable.
            onPointerDown={onMoveDown}
            onPointerMove={onMove}
            onPointerUp={onEnd}
            onPointerCancel={onEnd}
        >
            <button
                type="button"
                className="stt-cap__close floatwin__ctl"
                title="Hide the caption box"
                onClick={onClose}
            >
                <Icon.Close size={13} />
            </button>

            <div className="stt-cap__text">
                {text || <span className="stt-cap__hint">{hint}</span>}
            </div>

            {/* Only the press: the pointer is captured by the grip, so the
                moves and the release still bubble to the box's handlers above.
                Repeating them here would run the gesture twice per event. */}
            <span className="stt-cap__grip" title="Resize" onPointerDown={onSizeDown} />
        </div>,
        document.body,
    );
}
