// The marker under the dial and the ones either side of it, wired to the feeds.
//
// lib/markerNav.js is the pure part — hand it the lists and it tells you where
// the dial is. Getting hold of the lists is the other half, and it is the half
// with the decisions in it: which feeds this receiver actually has, which of
// them the operator is stepping between, and not subscribing to the rest. The
// Markers panel had all of that inline; the Multipad's barrel edges want exactly
// the same thing, and a second copy would be a second set of subscriptions to
// keep in step with lib/spotStore.js.
//
// `radio` is the useRadio() value, passed in rather than read here so lib stays
// clear of the contexts — the same arrangement lib/vfos.js uses.

import { useEffect, useMemo, useState } from '../react.js';
import { subscribeSpots } from './spotStore.js';
import { subscribeVoiceActivity } from './voiceActivity.js';
import { collectMarkers, findMarkers } from './markerNav.js';
import { onNavTypes, saveNavTypes, savedNavTypes } from './markerNavSettings.js';

// The shared selection of kinds to step between, as state that tracks it.
//
// Every consumer subscribes rather than reading once: the Markers panel and the
// Multipad both show a picker, and either may be the one changed. See
// lib/markerNavSettings.js for why it is one selection and not one each.
export function useNavTypes() {
    const [types, setTypes] = useState(savedNavTypes);
    useEffect(() => onNavTypes(setTypes), []);
    return [types, saveNavTypes];
}

// Stepping to a marker: its frequency, its mode if it named one, and the
// spectrum brought to it. The third part is the one worth sharing — a step that
// tunes outside the visible span leaves the operator looking at a spectrum with
// no needle in it, and the fix must be the same wherever the step came from.
export function stepToMarker(actions, marker) {
    if (!marker) return;
    actions.tuneTo({ frequency: marker.freq, mode: marker.mode || undefined });
    actions.ensureVisible(marker.freq);
}

export default function useMarkerNav(radio, types) {
    const { tuning, catalog, serverInfo, running } = radio;
    const [dx, setDx] = useState([]);
    const [cw, setCw] = useState([]);
    const [voice, setVoice] = useState([]);

    // Subscribed to only what this receiver has and only what is being stepped
    // between: the voice detector is a request every five seconds, and a feed
    // nobody is navigating by should cost nothing. The gates are booleans rather
    // than the array, so toggling one kind does not re-subscribe the others.
    const wantsDx = !!(running && serverInfo && serverInfo.dx_cluster && types.includes('dx'));
    const wantsCw = !!(running && serverInfo && serverInfo.cw_skimmer && types.includes('cw'));
    const wantsVoice = !!(running && serverInfo && serverInfo.noise_floor && types.includes('voice'));

    useEffect(() => {
        if (!wantsDx) { setDx([]); return undefined; }
        return subscribeSpots('dx', setDx);
    }, [wantsDx]);

    useEffect(() => {
        if (!wantsCw) { setCw([]); return undefined; }
        return subscribeSpots('cw', setCw);
    }, [wantsCw]);

    useEffect(() => {
        if (!wantsVoice) { setVoice([]); return undefined; }
        return subscribeVoiceActivity((state) => setVoice((state && state.activities) || []));
    }, [wantsVoice]);

    return useMemo(() => findMarkers(
        collectMarkers({
            dx,
            cw,
            voice,
            bookmarks: types.includes('bookmark-server') ? (catalog.bookmarks || []) : [],
            local: types.includes('bookmark-local') ? (catalog.local || []) : [],
        }),
        tuning.frequency,
        tuning.mode,
        types,
    ), [dx, cw, voice, catalog.bookmarks, catalog.local, tuning.frequency, tuning.mode, types]);
}
