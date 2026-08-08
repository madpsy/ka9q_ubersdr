// The server-feed gate as a React value, for feeds that are not a setInterval.
//
// Most pollers want feedInterval from lib/serverFeeds.js and never see this.
// The exceptions are the feeds that own a connection rather than a timer — the
// three EventSource panels and the two websockets — where the gate has to be a
// dependency of the effect that opens the thing, so that closing the gate tears
// it down and opening it builds it again:
//
//     const allowed = useFeedsAllowed();
//     useEffect(() => {
//         if (!allowed) return undefined;
//         …open the stream…
//         return () => …close it…;
//     }, [band, allowed]);

import { useEffect, useState } from '../react.js';
import { feedsAllowed, onFeedsAllowed } from './serverFeeds.js';

/** @returns {boolean} whether recurring server calls are permitted right now. */
export default function useFeedsAllowed() {
    const [on, setOn] = useState(feedsAllowed);
    // Re-read on subscribe as well as on change: the gate can move between the
    // first render and the effect running, and a feed that missed the edge
    // would stay shut until the next one.
    useEffect(() => {
        setOn(feedsAllowed());
        return onFeedsAllowed(setOn);
    }, []);
    return on;
}

export { useFeedsAllowed };
