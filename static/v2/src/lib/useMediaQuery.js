import { useEffect, useState } from '../react.js';

export function useMediaQuery(query) {
    const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
    useEffect(() => {
        const mq = window.matchMedia(query);
        const onChange = (e) => setMatches(e.matches);
        mq.addEventListener('change', onChange);
        setMatches(mq.matches);
        return () => mq.removeEventListener('change', onChange);
    }, [query]);
    return matches;
}

// The breakpoint at which side docks stop fitting alongside a usable spectrum.
export const MOBILE_QUERY = '(max-width: 900px)';

// Is there a finger available, wherever the primary pointer is?
//
// `any-pointer`, not `pointer`: on a convertible laptop or a touchscreen monitor
// the primary pointer is the mouse, so `pointer: coarse` says no — and the
// question being asked is not "how is this driven" but "can this be poked". A
// control that only earns its place under a fingertip, like the Multipad's
// barrels, wants the second question. Same reasoning as hapticsSupported().
//
// True on every phone and tablet as well, so callers that mean "touch but not a
// handset" have to say `!MOBILE_QUERY && TOUCH_QUERY` — which is exactly the
// machine that has room for docks and a screen worth spinning a drum on.
export const TOUCH_QUERY = '(any-pointer: coarse)';

// A handset turned on its side: wide enough, and nothing like tall enough.
//
// Keyed on the height, because height is the thing that has run out — a phone
// in landscape has about 390 CSS px of it, against 800 the other way up, and
// every fixed row costs more than a tenth of the screen. The orientation test is
// there to keep a merely short desktop window out of it; the height is what
// decides. 560 rather than 500 covers the taller handsets in landscape without
// reaching an ordinary portrait phone.
export const LANDSCAPE_QUERY = '(orientation: landscape) and (max-height: 560px)';
