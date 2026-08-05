// What the dial is sitting on, and what is either side of it.
//
// A port of widgets/marker.widget.html: the marker at the current frequency,
// the nearest one below and the nearest one above, and buttons that step to
// them. Callsign markers — spots and voice activity — are enriched with the
// operator's name and location from the lookup service, which is what the
// widget's "basic lookup info" is.
//
// The finding is lib/markerNav.js, which already existed for the lock-screen
// ⏮/⏭ buttons. This panel is a second consumer of it rather than a second
// implementation, so the two agree about what "the next marker" means.
//
// Which kinds count is a setting here rather than a shared one: skipping
// between DX spots on the lock screen and between bookmarks on screen are both
// reasonable, and neither should decide the other.
//
// `minimal` keeps the three markers and drops the type picker.

import React, { useEffect, useMemo, useState } from '../react.js';
import { Button, Empty, Field, Icon } from '../components/ui.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { getSessionId } from '../radio/session.js';
import { subscribeSpots } from '../lib/spotStore.js';
import { subscribeVoiceActivity } from '../lib/voiceActivity.js';
import { CALLSIGN_TYPES, collectMarkers, findMarkers } from '../lib/markerNav.js';
import { onLookupResolved, peekLookup, startLookup } from '../radio/media/lookup.js';
import { countryFlag, formatFreqShort } from '../lib/format.js';
import { NAV_LABELS, saveNavTypes, savedNavTypes } from '../lib/markerNavSettings.js';

export default function MarkerNavPanel({ minimal }) {
    const { tuning, actions, catalog, serverInfo, running } = useRadio();
    const [types, setTypes] = useState(savedNavTypes);
    const [dx, setDx] = useState([]);
    const [cw, setCw] = useState([]);
    const [voice, setVoice] = useState([]);

    // Subscribed to only what this receiver has and only what is being skipped
    // between: the voice detector is a request every five seconds, and a feed
    // nobody is navigating by should cost nothing.
    const wants = (t) => types.includes(t);
    const hasDx = !!(serverInfo && serverInfo.dx_cluster);
    const hasCw = !!(serverInfo && serverInfo.cw_skimmer);
    const hasVoice = !!(serverInfo && serverInfo.noise_floor);

    useEffect(() => {
        if (!running || !hasDx || !wants('dx')) { setDx([]); return undefined; }
        return subscribeSpots('dx', setDx);
    }, [running, hasDx, types]);

    useEffect(() => {
        if (!running || !hasCw || !wants('cw')) { setCw([]); return undefined; }
        return subscribeSpots('cw', setCw);
    }, [running, hasCw, types]);

    useEffect(() => {
        if (!running || !hasVoice || !wants('voice')) { setVoice([]); return undefined; }
        return subscribeVoiceActivity((state) => setVoice((state && state.activities) || []));
    }, [running, hasVoice, types]);

    const markers = useMemo(() => findMarkers(
        collectMarkers({
            dx,
            cw,
            voice,
            bookmarks: wants('bookmark-server') ? (catalog.bookmarks || []) : [],
            local: wants('bookmark-local') ? (catalog.local || []) : [],
        }),
        tuning.frequency,
        tuning.mode,
        types,
    ), [dx, cw, voice, catalog.bookmarks, catalog.local, tuning.frequency, tuning.mode, types]);

    // The operator behind a callsign marker. Only for the one you are on:
    // looking up the neighbours would be two more requests per turn of the dial.
    const current = markers.current;
    const wantsLookup = !!(current && CALLSIGN_TYPES.has(current.type) && current.name
        && serverInfo && serverInfo.lookup_service);
    useEffect(() => {
        if (wantsLookup) startLookup(current.name, getSessionId());
    }, [wantsLookup, current]);

    // The answer arrives a second or two after the request that asked for it.
    const [tick, setTick] = useState(0);
    useEffect(() => onLookupResolved(() => setTick((n) => n + 1)), []);
    const lookup = useMemo(
        () => (wantsLookup ? peekLookup(current.name) : null),
        [wantsLookup, current, tick],
    );

    const toggle = (t) => {
        const next = types.includes(t) ? types.filter((x) => x !== t) : [...types, t];
        // Never all-off: with nothing selected there is nothing to step to and
        // the panel would just be three dashes.
        if (!next.length) return;
        setTypes(next);
        saveNavTypes(next);
    };

    const step = (m) => {
        if (!m) return;
        actions.tuneTo({ frequency: m.freq, mode: m.mode || undefined });
        actions.ensureVisible(m.freq);
    };

    return (
        <div className="stack">
            <div className="mnav">
                <button
                    type="button"
                    className="mnav__step"
                    disabled={!markers.prev}
                    title={markers.prev
                        ? `${markers.prev.name || 'Marker'} — ${formatFreqShort(markers.prev.freq)}`
                        : 'Nothing below the dial'}
                    onClick={() => step(markers.prev)}
                >
                    <Icon.ChevronLeft size={14} />
                    <span className="mnav__step-label">
                        {markers.prev ? (markers.prev.name || formatFreqShort(markers.prev.freq)) : '—'}
                    </span>
                </button>

                <button
                    type="button"
                    className="mnav__step mnav__step--next"
                    disabled={!markers.next}
                    title={markers.next
                        ? `${markers.next.name || 'Marker'} — ${formatFreqShort(markers.next.freq)}`
                        : 'Nothing above the dial'}
                    onClick={() => step(markers.next)}
                >
                    <span className="mnav__step-label">
                        {markers.next ? (markers.next.name || formatFreqShort(markers.next.freq)) : '—'}
                    </span>
                    <Icon.ChevronRight size={14} />
                </button>
            </div>

            {current ? (
                <div className="mnav__now">
                    <span className={`mnav__type mnav__type--${current.type}`}>
                        {NAV_LABELS[current.type] || current.type}
                    </span>
                    <span className="mnav__name">{current.name || formatFreqShort(current.freq)}</span>
                    {lookup && lookup.country_code && (
                        <span className="mnav__flag">{countryFlag(lookup.country_code)}</span>
                    )}
                </div>
            ) : (
                <Empty>Nothing on this frequency</Empty>
            )}

            {/* What the lookup found, when it found anything. Two lines at most:
                this is context for what you are listening to, not the Callsign
                lookup panel in miniature. */}
            {current && lookup && (lookup.name || lookup.country || lookup.qth) && (
                <div className="mnav__who">
                    {lookup.name && <span className="mnav__who-name">{lookup.name}</span>}
                    {(lookup.qth || lookup.country) && (
                        <span className="mnav__who-qth">
                            {[lookup.qth, lookup.country].filter(Boolean).join(', ')}
                        </span>
                    )}
                </div>
            )}

            {!minimal && (
                <Field label="Skip between">
                    <div className="chip-row chip-row--wrap">
                        {Object.entries(NAV_LABELS).map(([t, label]) => (
                            <button
                                key={t}
                                type="button"
                                className={`chip chip--button${types.includes(t) ? ' is-on' : ''}`}
                                onClick={() => toggle(t)}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                </Field>
            )}
        </div>
    );
}
