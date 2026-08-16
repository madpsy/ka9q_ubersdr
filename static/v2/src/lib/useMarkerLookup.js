// Looking up whoever the dial has landed on.
//
// Landing on a callsign marker asks two things of the app: this row wants the
// operator's name and flag (radio/media/lookup.js, the small cached one the
// lock screen also reads), and the Callsign panel wants the whole record — the
// photo, the map, the distance. The second is a request routed through
// lib/callsign.js rather than a fetch, because whether anything is listening is
// the panel's business and not the dial's.
//
// It lived in the Markers panel, which meant it only happened while that panel
// was open. A collapsed dock section is unmounted, so the Multipad — which
// draws the same markers on its frequency drum, from the same lib/useMarkerNav.js
// — sat on a spotted callsign and looked nobody up, and the Callsign panel went
// on showing the previous station. Sharing the effect is what makes "the dial is
// on somebody" mean the same thing in both places. Same reasoning as
// components/CallsignAnnounceWatch.jsx, one step short of a global watch: this
// still costs nothing when neither panel is on screen, because neither is
// collecting markers then either.
//
// Both panels open at once is normal — the pad floats over the dock on a
// touchscreen desktop — so the two consumers must not turn one landing into two
// requests. Hence `recent` below.

import { useEffect, useMemo, useState } from '../react.js';
import { callsignOf } from './markerNav.js';
import { requestLookup } from './callsign.js';
import { onLookupResolved, peekLookup, startLookup } from '../radio/media/lookup.js';
import { getSessionId } from '../radio/session.js';
import { lookupCallsign } from '../compat/legacyBridge.js';

// The last automatic request, and when. Module level because the point is to be
// shared between whichever consumers happen to be mounted.
//
// A window rather than a plain "not the same callsign twice": tuning away from a
// station and back to it is a real landing and should refresh the panel, while
// two panels reacting to the same landing are a frame or two apart. Anything
// between those is arbitrary; a couple of seconds is comfortably outside a
// render and well inside a turn of the dial and back.
let recent = { call: '', at: 0 };
const SAME_MS = 2000;

/**
 * The operator behind a marker, for the panel that is showing it.
 *
 * Only the marker under the dial: looking up its neighbours would be two more
 * requests per turn. Returns the callsign (empty when the marker has none — a
 * bookmark, or voice activity with no station decoded, see callsignOf), whether
 * a lookup is possible at all, and whatever has come back for it so far.
 */
export default function useMarkerLookup(marker, serverInfo) {
    const call = callsignOf(marker);
    const wantsLookup = !!(call && serverInfo && serverInfo.lookup_service);

    useEffect(() => {
        if (!wantsLookup) return;
        // Ours: the name and flag beside the marker, from the shared cache.
        startLookup(call, getSessionId());

        // And the Callsign lookup panel, which is the one with the photo, the
        // map and the rest of it. Only when the marker changes — landing on a
        // station is the ask, not every render while you sit on it. The panel
        // wins when it is open; otherwise v1's popup gets it, if that is. This
        // never opens either of them. Marked automatic so a failure stays quiet:
        // nobody asked for this one, so an error banner about it is noise.
        const now = Date.now();
        if (recent.call === call && now - recent.at < SAME_MS) return;
        recent = { call, at: now };
        if (!requestLookup(call, { auto: true })) lookupCallsign(call);
    }, [wantsLookup, call]);

    // The answer arrives a second or two after the request that asked for it.
    const [tick, setTick] = useState(0);
    useEffect(() => onLookupResolved(() => setTick((n) => n + 1)), []);

    const lookup = useMemo(
        () => (wantsLookup ? peekLookup(call) : null),
        [wantsLookup, call, tick],
    );

    return { call, wantsLookup, lookup };
}

/** Test seam. */
export function _resetMarkerLookup() {
    recent = { call: '', at: 0 };
}
