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
import { subscribeConfirmedVoice } from './voiceConfirmed.js';
import { voiceSkimmerAvailable } from './voiceSkimmer.js';
import { collectMarkers, findMarkers } from './markerNav.js';
import { markerTarget } from './bookmarkTune.js';
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
    // A bookmark marker carries its passband, and stepping onto one should land on the
    // filter it was saved with — see lib/bookmarkTune.js.
    actions.tuneTo(markerTarget(marker));
    actions.ensureVisible(marker.freq);
}

export default function useMarkerNav(radio, types) {
    const { tuning, catalog, serverInfo, running } = radio;
    const [dx, setDx] = useState([]);
    const [cw, setCw] = useState([]);
    const [voice, setVoice] = useState([]);
    const [confirmed, setConfirmed] = useState([]);

    // Subscribed to only what this receiver has and only what is being stepped
    // between: the voice detector is a request every five seconds, and a feed
    // nobody is navigating by should cost nothing. The gates are booleans rather
    // than the array, so toggling one kind does not re-subscribe the others.
    const wantsDx = !!(running && serverInfo && serverInfo.dx_cluster && types.includes('dx'));
    const wantsCw = !!(running && serverInfo && serverInfo.cw_skimmer && types.includes('cw'));
    const wantsVoice = !!(running && serverInfo && serverInfo.noise_floor && types.includes('voice'));
    // The skimmer's confirmed callsigns are the other half of 'voice' — see
    // collectMarkers. Gated on its own addon rather than on the noise-floor
    // detector, because a receiver can have either without the other, and the
    // one selection has to work with whichever it has.
    const wantsConfirmed = !!(running && types.includes('voice')
        && voiceSkimmerAvailable(serverInfo));

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

    useEffect(() => {
        if (!wantsConfirmed) { setConfirmed([]); return undefined; }
        return subscribeConfirmedVoice((list) => setConfirmed(list || []));
    }, [wantsConfirmed]);

    // Collected once per *feed*, and deliberately not per dial position.
    //
    // This builds an object for every spot, every detected signal and every
    // bookmark — hundreds on a busy band. The dial has nothing to do with that
    // list, but it used to be in the dependencies anyway, so a spin rebuilt the
    // whole thing on every frame it stepped: hundreds of allocations per frame,
    // on the one path in this panel that has to keep up with a thumb. The drum
    // showed it as a flicker, and not only in the marks — the scale's own
    // numbers strobed, which is what dropped frames look like.
    const all = useMemo(() => collectMarkers({
        dx,
        cw,
        voice,
        confirmed,
        bookmarks: types.includes('bookmark-server') ? (catalog.bookmarks || []) : [],
        local: types.includes('bookmark-local') ? (catalog.local || []) : [],
    }), [dx, cw, voice, confirmed, catalog.bookmarks, catalog.local, types]);

    // ...and searched per dial position, which is a scan of that list and
    // allocates three references. `all` comes back with it: the drum's ends
    // want the nearest either way, and the marks along its middle want
    // everything in view — one collection, so the two cannot disagree about
    // what is out there.
    return useMemo(
        () => ({ ...findMarkers(all, tuning.frequency, tuning.mode, types), all }),
        [all, tuning.frequency, tuning.mode, types],
    );
}
