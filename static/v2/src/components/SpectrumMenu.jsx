// The spectrum's right-click menu.
//
// One entry for now — save the frequency under the pointer as a local bookmark
// — but the shape is the point: the menu is a list of items the caller passes
// in, so adding the next one is an entry in SpectrumView's array rather than
// anything here. Nothing about a bookmark is known in this file.
//
// Positioned at the click and nudged back on screen where that would put it
// over an edge, which is the one thing a context menu must always get right:
// the whole menu has to be reachable from where the pointer already is.

import React, { useEffect, useLayoutEffect, useRef, useState } from '../react.js';

// Kept clear of the viewport edge so the menu never sits flush against it.
const EDGE = 8;

export default function SpectrumMenu({ at, items, onClose }) {
    const ref = useRef(null);
    const [pos, setPos] = useState({ left: at.x, top: at.y, ready: false });

    // Measured, then placed: a menu whose height depends on how many entries it
    // has cannot know in advance whether it fits below the pointer.
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const maxLeft = window.innerWidth - r.width - EDGE;
        const maxTop = window.innerHeight - r.height - EDGE;
        setPos({
            left: Math.max(EDGE, Math.min(at.x, maxLeft)),
            top: Math.max(EDGE, Math.min(at.y, maxTop)),
            ready: true,
        });
    }, [at.x, at.y, items.length]);

    // Anything that is not a click on the menu closes it, including a second
    // right-click elsewhere — which then opens a fresh one where it landed.
    useEffect(() => {
        const away = (e) => {
            if (ref.current && ref.current.contains(e.target)) return;
            onClose();
        };
        const key = (e) => { if (e.key === 'Escape') onClose(); };
        // Capture, so a handler that stops propagation cannot strand the menu.
        document.addEventListener('pointerdown', away, true);
        document.addEventListener('contextmenu', away, true);
        document.addEventListener('keydown', key);
        window.addEventListener('blur', onClose);
        window.addEventListener('resize', onClose);
        return () => {
            document.removeEventListener('pointerdown', away, true);
            document.removeEventListener('contextmenu', away, true);
            document.removeEventListener('keydown', key);
            window.removeEventListener('blur', onClose);
            window.removeEventListener('resize', onClose);
        };
    }, [onClose]);

    return (
        <div
            ref={ref}
            className="specmenu"
            role="menu"
            // Hidden until measured, or the first paint shows it at the click
            // point and it visibly jumps to where it fits.
            style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}
        >
            {items.map((item) => (
                item.separator ? (
                    <div key={item.key} className="specmenu__sep" />
                ) : (
                    <button
                        key={item.key}
                        type="button"
                        role="menuitem"
                        className="specmenu__item"
                        disabled={item.disabled}
                        title={item.title}
                        onClick={() => { onClose(); item.onSelect(); }}
                    >
                        {item.label}
                    </button>
                )
            ))}
        </div>
    );
}
