// A spot on a map, from a click on a row that cannot be tuned.
//
// Digital rows are the case: every station in a decoder band sits on the same
// dial frequency, so pressing one cannot mean "go there" — and until now it
// meant nothing at all. What it can mean is "who is that, and where", which is
// two questions with two answers and one picture that holds both.
//
// ── Where the position comes from ───────────────────────────────────────────
//
// Two sources, in this order, and the order is about how precise the answer is
// rather than how convenient it is to get:
//
//   the lookup    an operator's own coordinates, or the grid square they
//                 published. As precise as anything here gets, and it carries a
//                 name and a country with it. Only where the receiver has a
//                 lookup service configured.
//
//   the locator   the grid square the decoder itself reported with the spot.
//                 Free — it arrived with the row — and good to a hundred
//                 kilometres or so, which is a town rather than a street. What
//                 it does not carry is any idea of *who* the station is, so the
//                 country comes from /api/cty, which answers from the callsign's
//                 prefix and is the same table the spot's own country column is
//                 filled from.
//
// A grid-derived position is marked with a tilde wherever it is shown, as the
// Callsign panel's distance readout marks its own: it is the centre of a square
// and not an address, and a map is very good at making a guess look like a fact.
//
// Nothing is fetched until the modal opens. The lookup is the same shared,
// deduplicated request the Callsign panel makes — clicking a row already asks
// for one, so opening this costs nothing extra where a panel is listening.

import React, { useEffect, useState } from '../react.js';
import { Empty, Modal } from './ui.jsx';
import CallsignMap from './CallsignMap.jsx';
import { getSessionId } from '../radio/session.js';
import {
    displayName, lookupCallsignData, maidenheadToLatLon, positionOf,
} from '../lib/callsign.js';

// The prefix table the server already serves — the same one behind the country
// column on the row that opened this. Never fatal: a receiver without it loses
// the country line and keeps the map.
async function ctyOf(call) {
    try {
        const r = await fetch(`/api/cty/lookup?callsign=${encodeURIComponent(call)}`);
        if (!r.ok) return null;
        const body = await r.json();
        return (body && body.data) || null;
    } catch (e) {
        return null;
    }
}

/**
 * What to draw and what to say, from whichever source could answer.
 *
 * Returns { position, lines, source } — or a position of null, which is a real
 * outcome rather than a failure: a lookup that knows the operator but not where
 * they are is common, and so is a decoder that reports no grid.
 */
async function resolve(spot, lookups) {
    const call = spot.callsign;
    const lines = [];

    if (lookups) {
        try {
            const data = await lookupCallsignData(call, getSessionId());
            const position = positionOf(data);
            if (position) {
                const name = displayName(data);
                const country = data.country || (data.cty && data.cty.country) || spot.country || '';
                if (name) lines.push(name);
                if (country) lines.push(country);
                if (data.grid) lines.push(`Grid ${data.grid}`);
                return { position, lines, source: 'lookup' };
            }
        } catch (e) {
            // No answer, a rate limit, a provider that has never heard of them:
            // the locator below is not a worse answer than no map at all.
        }
    }

    const grid = spot.grid || '';
    const at = grid ? maidenheadToLatLon(grid) : null;
    if (!at) return { position: null, lines, source: 'none' };

    const cty = await ctyOf(call);
    const country = (cty && cty.country) || spot.country || '';
    if (country) lines.push(country);
    if (cty && cty.continent) lines.push(`${cty.continent}  CQ ${cty.cq_zone}  ITU ${cty.itu_zone}`);
    lines.push(`Grid ${grid}`);
    return { position: { ...at, fromGrid: true }, lines, source: 'grid' };
}

export default function SpotMap({ spot, lookups, onClose }) {
    const [state, setState] = useState(null);

    useEffect(() => {
        let cancelled = false;
        setState(null);
        resolve(spot, lookups).then((r) => { if (!cancelled) setState(r); });
        return () => { cancelled = true; };
    }, [spot.key, spot.callsign, lookups]);

    const call = spot.callsign;

    return (
        <Modal onClose={onClose} label={`${call} on the map`}>
            <div className="spotmap">
                <div className="spotmap__head">
                    <span className="spotmap__call">{call}</span>
                    {/* What the row already said, kept in front of the map: the
                        modal covers the list it came from, and a mode and an SNR
                        are what make one decode different from the next. */}
                    <span className="spotmap__meta">
                        {[
                            spot.submode ? `${spot.mode}/${spot.submode}` : spot.mode,
                            spot.snr != null ? `${spot.snr > 0 ? '+' : ''}${spot.snr} dB` : '',
                            spot.distanceKm != null ? `${Math.round(spot.distanceKm)} km` : '',
                        ].filter(Boolean).join('  ·  ')}
                    </span>
                </div>

                {state == null && <Empty>Locating {call}…</Empty>}

                {state && state.position && (
                    <CallsignMap
                        call={call}
                        position={state.position}
                        lines={state.lines}
                        className="csmap--modal"
                    />
                )}

                {/* Neither source could place them. Said plainly, with what is
                    known: a decoder that reports no grid and a lookup that has
                    no coordinates is an ordinary outcome, not an error, and the
                    country is still worth reading. */}
                {state && !state.position && (
                    <Empty>
                        {`No position for ${call}.`}
                        {spot.country ? ` ${spot.country}, from the callsign's prefix.` : ''}
                        {lookups ? '' : ' This receiver has no callsign lookup service.'}
                    </Empty>
                )}

                {/* Where the pin came from, because the two are not the same
                    claim — see the note at the top. */}
                {state && state.position && (
                    <div className="spotmap__source">
                        {state.source === 'grid'
                            ? `Positioned from the reported locator — accurate to the grid square, not the address.`
                            : 'Positioned from the callsign lookup.'}
                    </div>
                )}
            </div>
        </Modal>
    );
}
