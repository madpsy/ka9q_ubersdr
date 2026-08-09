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
import { countryFlag } from '../lib/format.js';
import {
    displayName, distanceBearing, lookupCallsignData, maidenheadToLatLon, positionOf,
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
                // The map's own label stays short — a name and a place. Everything
                // else the lookup and the spot know is in the rows beside it, where
                // there is room to name each field.
                if (name) lines.push(name);
                if (country) lines.push(country);
                return {
                    position, lines, source: 'lookup', name, cty: null, grid: data.grid || '',
                };
            }
        } catch (e) {
            // No answer, a rate limit, a provider that has never heard of them:
            // the locator below is not a worse answer than no map at all.
        }
    }

    // Asked for either way, because it is what the details show as continent and
    // zones — the spot carries a country and nothing else about the entity.
    const cty = await ctyOf(call);
    const grid = spot.grid || '';
    const at = grid ? maidenheadToLatLon(grid) : null;
    if (!at) return { position: null, lines, source: 'none', cty };

    const country = (cty && cty.country) || spot.country || '';
    if (country) lines.push(country);
    lines.push(`Grid ${grid}`);
    return { position: { ...at, fromGrid: true }, lines, source: 'grid', cty, grid };
}

function Row({ k, children }) {
    if (children == null || children === '' || children === false) return null;
    return (
        <div className="kv">
            <span className="kv__k">{k}</span>
            <span className="kv__v">{children}</span>
        </div>
    );
}

/**
 * Everything the spot itself carried, as rows.
 *
 * The row that opened this had four columns and a tooltip; this is the same
 * record with nothing left out and nothing abbreviated to fit a dock. The
 * decoder's own reading of the transmission — mode, submode, SNR, the message
 * as sent — is the part that cannot be got anywhere else: a lookup can always be
 * repeated, that decode happened once.
 *
 * `cty` is what the prefix table added, and only where it was asked: the country
 * is on the spot already, the zones are not.
 */
function Details({ spot, cty, distance }) {
    const mhz = (spot.frequency / 1e6).toFixed(spot.frequency >= 1e6 ? 4 : 6);
    const flag = countryFlag(spot.countryCode);
    const country = spot.country || (cty && cty.country) || '';
    const zones = cty && (cty.cq_zone || cty.itu_zone)
        ? [cty.cq_zone ? `CQ ${cty.cq_zone}` : '', cty.itu_zone ? `ITU ${cty.itu_zone}` : '']
            .filter(Boolean).join('  ·  ')
        : '';

    return (
        <div className="spotmap__facts">
            <Row k="Heard">{`${new Date(spot.at).toISOString().slice(11, 19)} UTC`}</Row>
            <Row k="Frequency">{`${mhz} MHz`}</Row>
            <Row k="Mode">{spot.submode ? `${spot.mode} / ${spot.submode}` : spot.mode}</Row>
            <Row k="SNR">{spot.snr != null ? `${spot.snr > 0 ? '+' : ''}${spot.snr} dB` : null}</Row>
            <Row k="Speed">{spot.wpm != null ? `${spot.wpm} WPM` : null}</Row>
            <Row k="Country">{country ? `${flag ? `${flag} ` : ''}${country}` : null}</Row>
            <Row k="Continent">{cty && cty.continent ? cty.continent : null}</Row>
            <Row k="Zones">{zones}</Row>
            <Row k="Locator">{spot.grid || null}</Row>
            {/* From the receiver, which is what makes it worth printing: the
                same pair the red path on the map draws. Marked where the
                position it was measured from is a grid square. */}
            <Row k="Distance">
                {distance
                    ? `${distance.distKm.toLocaleString()} km  ·  ${distance.bearing}°${distance.fromGrid ? ' ~' : ''}`
                    : null}
            </Row>
            <Row k="Spotted by">{spot.spotter || null}</Row>
            {/* Last, and the widest: an FT8 exchange is the only line here that
                is a sentence rather than a field. */}
            <Row k="Message">{spot.message || spot.comment || null}</Row>
        </div>
    );
}

export default function SpotMap({ spot, lookups, receiver, onClose }) {
    const [state, setState] = useState(null);

    useEffect(() => {
        let cancelled = false;
        setState(null);
        resolve(spot, lookups).then((r) => { if (!cancelled) setState(r); });
        return () => { cancelled = true; };
    }, [spot.key, spot.callsign, lookups]);

    const call = spot.callsign;
    const flag = countryFlag(spot.countryCode);

    // Where the receiver is, when it has said. 0,0 is the config default rather
    // than a position — the Callsign panel's Beam readout rejects it the same
    // way — and a path drawn from the Gulf of Guinea is worse than no path.
    const rx = receiver && receiver.gps && (receiver.gps.lat || receiver.gps.lon)
        ? { lat: receiver.gps.lat, lon: receiver.gps.lon, label: receiver.callsign || 'Receiver' }
        : null;

    // Preferring the server's own figure keeps this line and the spot list
    // saying the same thing; computing it is for the fallback, where the
    // position came from a locator the server did not measure against.
    let distance = null;
    if (spot.distanceKm != null) {
        distance = {
            distKm: Math.round(spot.distanceKm),
            bearing: Math.round(spot.bearingDeg || 0),
            fromGrid: false,
        };
    } else if (rx && state && state.position) {
        const db = distanceBearing(rx.lat, rx.lon, state.position.lat, state.position.lon);
        if (db) distance = { ...db, fromGrid: !!state.position.fromGrid };
    }

    return (
        <Modal onClose={onClose} label={`${call} on the map`}>
            <div className="spotmap">
                <div className="spotmap__head">
                    <span className="spotmap__call">{flag ? `${flag} ${call}` : call}</span>
                    {/* The one line that says which decode this was, in front of
                        everything else: the modal covers the list it came from,
                        and a mode and an SNR are what tell one row from the next.
                        Repeated in the rows below, where each has a name — this
                        is for recognising the row, those are for reading it. */}
                    <span className="spotmap__meta">
                        {[
                            spot.submode ? `${spot.mode}/${spot.submode}` : spot.mode,
                            spot.snr != null ? `${spot.snr > 0 ? '+' : ''}${spot.snr} dB` : '',
                            `${(spot.frequency / 1e6).toFixed(4)} MHz`,
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
                        from={rx}
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

                {/* Everything the decoder reported, named. Shown whether or not
                    a position was found: a spot with no locator is still a spot,
                    and the message it carried is the part that only happened
                    once. */}
                <Details spot={spot} cty={state && state.cty} distance={distance} />

                {/* Where the pin came from, because the two are not the same
                    claim — see the note at the top. */}
                {state && state.position && (
                    <div className="spotmap__source">
                        {state.source === 'grid'
                            ? 'Positioned from the reported locator — accurate to the grid square, not the address.'
                            : 'Positioned from the callsign lookup.'}
                        {rx ? ' The green pin is this receiver; the dashed path is the great circle between them.' : ''}
                    </div>
                )}
            </div>
        </Modal>
    );
}
