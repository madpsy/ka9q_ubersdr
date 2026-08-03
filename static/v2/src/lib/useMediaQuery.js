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
