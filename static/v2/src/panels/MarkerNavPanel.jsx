// What the dial is sitting on, and what is either side of it.
//
// A port of widgets/marker.widget.html: the marker at the current frequency,
// the nearest one below and the nearest one above, and buttons that step to
// them. Callsign markers — spots and voice activity — are enriched with the
// operator's name and location from the lookup service, which is what the
// widget's "basic lookup info" is.
//
// The finding is lib/markerNav.js, which already existed for the lock-screen
// ⏮/⏭ buttons, and the feeds behind it are lib/useMarkerNav.js, shared with the
// Multipad's barrel edges. This panel is a consumer of both rather than a second
// implementation, so all three agree about what "the next marker" means.
//
// Which kinds count is the one on-screen selection, shared with the Multipad's
// barrel edges — but not with the lock screen, which keeps its own. See
// lib/markerNavSettings.js.
//
// `minimal` keeps the three markers and drops the type picker.

import React, { useEffect, useMemo, useState } from '../react.js';
import { Empty, Icon } from '../components/ui.jsx';
import NavTypes from '../components/NavTypes.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { getSessionId } from '../radio/session.js';
import { callsignOf, countryOf } from '../lib/markerNav.js';
import useMarkerNav, { stepToMarker, useNavTypes } from '../lib/useMarkerNav.js';
import { onLookupResolved, peekLookup, startLookup } from '../radio/media/lookup.js';
import { countryFlag, formatFreqShort } from '../lib/format.js';
import { requestLookup } from '../lib/callsign.js';
import { lookupCallsign } from '../compat/legacyBridge.js';
import { NAV_LABELS } from '../lib/markerNavSettings.js';

export default function MarkerNavPanel({ minimal }) {
    const radio = useRadio();
    const { serverInfo } = radio;
    const [types] = useNavTypes();
    const markers = useMarkerNav(radio, types);

    // The operator behind a callsign marker. Only for the one you are on:
    // looking up the neighbours would be two more requests per turn of the dial.
    const current = markers.current;
    // Not merely a callsign *type*: voice activity with no station decoded is
    // labelled "Voice 20m", which is not something to look anybody up by.
    const call = callsignOf(current);
    const wantsLookup = !!(call && serverInfo && serverInfo.lookup_service);
    useEffect(() => {
        if (!wantsLookup) return;
        // Ours, for the name and flag on this row.
        startLookup(call, getSessionId());
        // And the Callsign lookup panel, which is the one with the photo, the
        // map and the rest of it. Only when the marker changes — landing on a
        // station is the ask, not every render while you sit on it. The panel
        // wins when it is open; otherwise v1's popup gets it, if that is. This
        // never opens either of them. Marked automatic so a failure stays quiet:
        // nobody asked for this one, so an error banner about it is noise.
        if (!requestLookup(call, { auto: true })) lookupCallsign(call);
    }, [wantsLookup, call]);

    // The answer arrives a second or two after the request that asked for it.
    const [tick, setTick] = useState(0);
    useEffect(() => onLookupResolved(() => setTick((n) => n + 1)), []);
    const lookup = useMemo(
        () => (wantsLookup ? peekLookup(call) : null),
        [wantsLookup, call, tick],
    );

    const step = (m) => stepToMarker(radio.actions, m);

    // Why a step button is dead, which is two different reasons. Deselecting
    // every kind turns stepping off — the Multipad's barrel edges take
    // themselves away at that point, because there they were occupying the drum;
    // here the row stays, because a panel whose top half came and went with a
    // setting reads as broken, and two dashes with a tooltip do not.
    const why = (m, below) => {
        if (m) return `${m.name || 'Marker'} — ${formatFreqShort(m.freq)}`;
        if (!types.length) return 'No marker kinds selected to step between';
        return below ? 'Nothing below the dial' : 'Nothing above the dial';
    };

    return (
        <div className="stack">
            <div className="mnav">
                <button
                    type="button"
                    className="mnav__step"
                    disabled={!markers.prev}
                    title={why(markers.prev, true)}
                    onClick={() => step(markers.prev)}
                >
                    <Icon.ChevronLeft size={14} />
                    <span className="mnav__step-label">
                        {markers.prev ? (markers.prev.name || formatFreqShort(markers.prev.freq)) : '—'}
                    </span>
                    {/* On the inner side of each button — right of the callsign
                        going back, left of it going forward — so the two flags
                        face each other across the row rather than hugging the
                        chevrons. */}
                    {countryOf(markers.prev) && (
                        <span className="mnav__step-flag">{countryFlag(countryOf(markers.prev))}</span>
                    )}
                </button>

                <button
                    type="button"
                    className="mnav__step mnav__step--next"
                    disabled={!markers.next}
                    title={why(markers.next, false)}
                    onClick={() => step(markers.next)}
                >
                    {countryOf(markers.next) && (
                        <span className="mnav__step-flag">{countryFlag(countryOf(markers.next))}</span>
                    )}
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
                    {/* Left of the callsign, as everywhere else in this
                        interface — and instead of the country on a line of its
                        own, which was a whole row spent on something a flag
                        says in one character. */}
                    {(countryOf(current) || (lookup && lookup.country_code)) && (
                        <span
                            className="mnav__flag"
                            title={(lookup && lookup.country) || ''}
                        >
                            {countryFlag(countryOf(current) || lookup.country_code)}
                        </span>
                    )}
                    {wantsLookup ? (
                        <button
                            type="button"
                            className="mnav__name mnav__name--call"
                            title={`Look up ${call}`}
                            onClick={() => {
                                if (!requestLookup(call)) lookupCallsign(call);
                            }}
                        >
                            {current.name}
                        </button>
                    ) : (
                        <span className="mnav__name">{current.name || formatFreqShort(current.freq)}</span>
                    )}
                </div>
            ) : (
                /* With every kind deselected nothing is being collected, so this
                   line cannot claim the frequency is bare — there may well be a
                   spot on it, and the panel has simply been told not to look. */
                <Empty>{types.length ? 'Nothing on this frequency' : 'No marker kinds selected'}</Empty>
            )}

            {/* Who they are and where — the country is not repeated here,
                because the flag beside the callsign already said it. */}
            {current && lookup && (lookup.name || lookup.qth) && (
                <div className="mnav__who">
                    {lookup.name && <span className="mnav__who-name">{lookup.name}</span>}
                    {lookup.qth && <span className="mnav__who-qth">{lookup.qth}</span>}
                </div>
            )}

            {!minimal && <NavTypes />}
        </div>
    );
}
