// The size of the page, as something a component can render from.
//
// `--app-height` is the same measurement written to a custom property, which is
// right for CSS and no use to arithmetic in JavaScript. Both read the same
// thing: whatever the window says it is right now, which on a tablet changes
// every time a keyboard opens, because both apps shorten the page rather than
// letting the keys cover it.

import { useEffect, useState } from '../react.js';

const read = () => ({
    w: typeof window === 'undefined' ? 0 : window.innerWidth || 0,
    h: typeof window === 'undefined' ? 0 : window.innerHeight || 0,
});

export function useViewport() {
    const [size, setSize] = useState(read);

    useEffect(() => {
        // Same value, same object: this fires on every visual-viewport scroll,
        // and a fresh object each time would re-render every floating window
        // for nothing.
        const apply = () => setSize((prev) => {
            const next = read();
            return next.w === prev.w && next.h === prev.h ? prev : next;
        });
        apply();
        window.addEventListener('resize', apply);
        window.addEventListener('orientationchange', apply);
        const vv = window.visualViewport;
        if (vv) vv.addEventListener('resize', apply);
        return () => {
            window.removeEventListener('resize', apply);
            window.removeEventListener('orientationchange', apply);
            if (vv) vv.removeEventListener('resize', apply);
        };
    }, []);

    return size;
}
