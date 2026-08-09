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

import React, { useEffect, useMemo, useState } from '../react.js';
import { Button, Empty, Icon, Modal } from './ui.jsx';
import CallsignMap from './CallsignMap.jsx';
import SpotsWorldMap, { placeable } from './SpotsWorldMap.jsx';
import { getSessionId } from '../radio/session.js';
import { countryFlag } from '../lib/format.js';
import {
    displayName, distanceBearing, lookupCallsignData, maidenheadToLatLon, positionOf,
} from '../lib/callsign.js';
import {
    AGE_OPTIONS, BANDS, DIGITAL_MODES, SNR_OPTIONS, WPM_OPTIONS,
    countriesIn, filterSpots,
} from '../lib/spots.js';

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
            {/* The skimmer adds these when it runs with callsign lookup on, and
                only then — so they are absent far more often than not. */}
            <Row k="Name">{spot.name || null}</Row>
            <Row k="State">{spot.state || null}</Row>
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

// The map's own filters, kept apart from the panel's.
//
// The list behind the panel is filtered for reading — an age window so it does
// not run away, a band because that is what you are listening to. The map is
// asked a different question: not "what came in just now" but "where has this
// band been reaching", which wants a wider net by default and its own controls
// to narrow it. Filtering the map by the list's settings would also mean the map
// silently changed whenever somebody adjusted the list behind it.
const MAP_FILTERS = {
    age: null,
    band: 'all',
    mode: 'all',
    country: 'all',
    callsign: '',
    minSnr: null,
    minWpm: null,
    minDistance: null,
    // CW only, and the opposite of the list's default: v1 hides 10m beacons from
    // a table because they crowd it, and on a map they are the clearest picture
    // of where 10m is open that this receiver has.
    tenMeterBeacons: true,
};

// Free text, over everything a spot says in words. The panel's own callsign box
// matches callsigns only, which is right for a list you are scanning by callsign
// and too narrow here: on a map the question is as often "who is in Norway" or
// "who called CQ" as it is "where is G4ABC".
function matchesText(spot, query) {
    if (!query) return true;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [
        spot.callsign, spot.mode, spot.submode, spot.country, spot.grid,
        spot.message, spot.comment, spot.spotter,
    ].some((v) => v && String(v).toLowerCase().includes(q));
}

function Pick({ label, value, onChange, children }) {
    return (
        <label className="spotmap__pick">
            <span className="spotmap__pick-label">{label}</span>
            <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
                {children}
            </select>
        </label>
    );
}

const toValue = (v) => (v == null ? '' : String(v));
const fromValue = (v) => (v === '' ? null : Number(v));

export default function SpotMap({
    spot: opened, spots, kind = 'digital', lookups, receiver, onClose,
}) {
    const [state, setState] = useState(null);
    // Which spot the single view is showing. Starts as the row that was clicked
    // and changes when a point on the all-spots map is picked, so switching back
    // and forth never loses where you were.
    const [spot, setSpot] = useState(opened);
    useEffect(() => { setSpot(opened); }, [opened]);
    // 'one' or 'all'. Opens on the spot that was clicked: somebody who pressed a
    // row asked about that row, and the wider map is one press away.
    const [view, setView] = useState('one');
    const [filters, setFilters] = useState(MAP_FILTERS);
    const [query, setQuery] = useState('');

    useEffect(() => {
        let cancelled = false;
        setState(null);
        resolve(spot, lookups).then((r) => { if (!cancelled) setState(r); });
        return () => { cancelled = true; };
    }, [spot.key, spot.callsign, lookups]);

    // A clock for the age filter, and only while it is being used. Without it an
    // age window is only re-applied when a spot arrives — right on a busy band
    // and wrong on a quiet one, where the map would go on showing a decode from
    // twenty minutes ago under a ten-minute filter until something else came in.
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (view !== 'all' || filters.age == null) return undefined;
        const id = setInterval(() => setNow(Date.now()), 15000);
        return () => clearInterval(id);
    }, [view, filters.age]);

    const all = spots || [];
    // Filtered with the panel's own function, so a band or a mode means exactly
    // what it means in the list — then the free text on top, which the list has
    // no equivalent of.
    const shown = useMemo(
        () => filterSpots(all, filters, now, null).filter((s) => matchesText(s, query)),
        [all, filters, query, now],
    );
    const points = useMemo(() => placeable(shown), [shown]);
    const countries = useMemo(() => countriesIn(all), [all]);
    const set = (patch) => setFilters((prev) => ({ ...prev, ...patch }));

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

    // A map of every spot needs every spot to say where it is, and a cluster spot
    // never does — DXSpot on the server carries a callsign, a band and a country
    // and no locator at all. So the DX tab gets this modal without its second
    // view: an "all spots" button that could only ever open an empty map is a
    // button that teaches somebody the feature does not work.
    const canShowAll = kind !== 'dx';
    const many = canShowAll && view === 'all';

    return (
        <Modal onClose={onClose} label={many ? 'Digital spots on the map' : `${call} on the map`}>
            <div className={`spotmap${many ? ' spotmap--wide' : ''}`}>
                <div className="spotmap__head">
                    <span className="spotmap__call">
                        {many ? 'All spots' : (flag ? `${flag} ${call}` : call)}
                    </span>
                    {/* The one line that says which decode this was, in front of
                        everything else: the modal covers the list it came from,
                        and a mode and an SNR are what tell one row from the next.
                        Repeated in the rows below, where each has a name — this
                        is for recognising the row, those are for reading it. */}
                    <span className="spotmap__meta">
                        {many
                            ? `${points.length} of ${shown.length} shown${shown.length === all.length ? '' : ` · ${all.length} held`}`
                            : [
                                spot.submode ? `${spot.mode}/${spot.submode}` : spot.mode,
                                spot.snr != null ? `${spot.snr > 0 ? '+' : ''}${spot.snr} dB` : '',
                                `${(spot.frequency / 1e6).toFixed(4)} MHz`,
                            ].filter(Boolean).join('  ·  ')}
                    </span>
                    {/* The two views, one button. There are exactly two and each
                        names the other, which is what a toggle is for — and it
                        sits in the title row because it changes what the whole
                        modal is about rather than what is in it. */}
                    {canShowAll && (
                        <Button
                            size="sm"
                            variant="ghost"
                            className="spotmap__swap"
                            icon={many ? <Icon.Target /> : <Icon.Grid />}
                            title={many
                                ? `Back to ${call} on its own`
                                : 'Show every spot that reported a locator'}
                            onClick={() => setView(many ? 'one' : 'all')}
                        >
                            {many ? call : 'Show all'}
                        </Button>
                    )}
                </div>

                {/* Only in the all-spots view, and the same vocabulary the panel
                    filters its list with — a band is a band and a mode is a mode
                    in both, which is the difference between two controls and two
                    ideas. The text box is the one thing beyond the list's own
                    filters: over the map, "who is in Norway" and "who called CQ"
                    are asked as often as "where is G4ABC". */}
                {many && (
                    <div className="spotmap__filters">
                        <Pick label="Band" value={filters.band} onChange={(v) => set({ band: v })}>
                            <option value="all">All bands</option>
                            {BANDS.map((b) => <option key={b} value={b}>{b}</option>)}
                        </Pick>
                        {/* One tab's filter each: every CW spot is CW, and no
                            digital spot has a speed. Offering the other would be
                            a control that could only ever match everything or
                            nothing. */}
                        {kind === 'digital' && (
                            <Pick label="Mode" value={filters.mode} onChange={(v) => set({ mode: v })}>
                                <option value="all">All modes</option>
                                {DIGITAL_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                            </Pick>
                        )}
                        {kind === 'cw' && (
                            <Pick
                                label="Min WPM"
                                value={toValue(filters.minWpm)}
                                onChange={(v) => set({ minWpm: fromValue(v) })}
                            >
                                {WPM_OPTIONS.map((v) => (
                                    <option key={toValue(v)} value={toValue(v)}>
                                        {v == null ? 'No limit' : `${v} WPM`}
                                    </option>
                                ))}
                            </Pick>
                        )}
                        <Pick label="Country" value={filters.country} onChange={(v) => set({ country: v })}>
                            <option value="all">All countries</option>
                            {countries.map((c) => <option key={c} value={c}>{c}</option>)}
                        </Pick>
                        <Pick
                            label="Age"
                            value={toValue(filters.age)}
                            onChange={(v) => set({ age: fromValue(v) })}
                        >
                            {(AGE_OPTIONS[kind] || AGE_OPTIONS.digital).map((m) => (
                                <option key={toValue(m)} value={toValue(m)}>
                                    {m == null ? 'No limit' : `${m} min`}
                                </option>
                            ))}
                        </Pick>
                        <Pick
                            label="Min SNR"
                            value={toValue(filters.minSnr)}
                            onChange={(v) => set({ minSnr: fromValue(v) })}
                        >
                            {(SNR_OPTIONS[kind] || SNR_OPTIONS.digital).map((v) => (
                                <option key={toValue(v)} value={toValue(v)}>
                                    {v == null ? 'No limit' : `${v > 0 ? '+' : ''}${v} dB`}
                                </option>
                            ))}
                        </Pick>
                        <label className="spotmap__pick spotmap__pick--wide">
                            <span className="spotmap__pick-label">Search</span>
                            <input
                                className="input"
                                value={query}
                                placeholder="callsign, grid, country, message…"
                                autoComplete="off"
                                spellCheck={false}
                                onChange={(e) => setQuery(e.target.value)}
                            />
                        </label>
                    </div>
                )}

                {many && (
                    <SpotsWorldMap
                        points={points}
                        receiver={receiver}
                        className="csmap--modal csmap--world"
                        // Picking a point is asking about that station, which is
                        // the other view's whole job — so it switches, rather
                        // than growing a second way to say the same thing.
                        onPick={(s) => { setSpot(s); setView('one'); }}
                    />
                )}

                {many && !points.length && (
                    <Empty>
                        {shown.length
                            ? 'None of the matching spots reported a locator.'
                            : 'No spots match those filters.'}
                    </Empty>
                )}

                {!many && state == null && <Empty>Locating {call}…</Empty>}

                {!many && state && state.position && (
                    <CallsignMap
                        call={call}
                        position={state.position}
                        lines={state.lines}
                        className="csmap--modal"
                        from={rx}
                        zoomable
                    />
                )}

                {/* Neither source could place them. Said plainly, with what is
                    known: a decoder that reports no grid and a lookup that has
                    no coordinates is an ordinary outcome, not an error, and the
                    country is still worth reading. */}
                {!many && state && !state.position && (
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
                {!many && <Details spot={spot} cty={state && state.cty} distance={distance} />}

                {/* Only the locator case says anything, and only because it is a
                    caveat: the pin is the centre of a grid square rather than an
                    address, and a map is very good at making a guess look like a
                    fact. The lookup case said "positioned from the callsign
                    lookup", which is what the operator had just asked for, and a
                    line explaining that the green pin was the receiver and the
                    dashed path the way between them described a picture already
                    on screen. Both are gone. */}
                {!many && state && state.position && state.source === 'grid' && (
                    <div className="spotmap__source">
                        Positioned from the reported locator — accurate to the grid square, not the address.
                    </div>
                )}
            </div>
        </Modal>
    );
}
