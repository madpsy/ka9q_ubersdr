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

// A handset turned on its side: wide enough, and nothing like tall enough.
//
// Keyed on the height, because height is the thing that has run out — a phone
// in landscape has about 390 CSS px of it, against 800 the other way up, and
// every fixed row costs more than a tenth of the screen. The orientation test is
// there to keep a merely short desktop window out of it; the height is what
// decides. 560 rather than 500 covers the taller handsets in landscape without
// reaching an ordinary portrait phone.
export const LANDSCAPE_QUERY = '(orientation: landscape) and (max-height: 560px)';
