// Spots — DX cluster, digital-mode decodes and CW skimmer, in one panel.
//
// v1 ships these as three separate extensions the operator has to enable in
// extensions.yaml, only one of which can be open at a time. Here they are three
// tabs of a panel that appears whenever the instance actually has the feed:
// `/api/description` reports `dx_cluster`, `digital_decodes` and `cw_skimmer`,
// and a tab is present only for the ones that are on. A receiver with none of
// them never shows the panel at all.
//
// The behaviour is v1's, because v1's works: the same columns, the same filters
// with the same defaults, newest first, click a row to tune. The mode a row
// tunes to is inferred exactly as the v1 extensions infer it — see
// lib/spots.js.
//
// All three ride the one `/ws/dxcluster` socket that chat uses. Only the tab
// you are looking at is subscribed: the server replays its buffer on every
// subscribe, so switching tabs restores the history rather than losing it, and
// nobody carries a busy digital feed for a tab they are not reading.

import React, { useEffect, useMemo, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { useLayout } from '../layout/LayoutContext.jsx';
import { Button, Empty, Icon, Segmented, ShowMore } from '../components/ui.jsx';
import SpotMap from '../components/SpotMap.jsx';
import { countryFlag } from '../lib/format.js';
import { lookupCallsign } from '../compat/legacyBridge.js';
import { requestLookup } from '../lib/callsign.js';
import { getSessionId } from '../radio/session.js';
import { dxcluster } from '../radio/dxcluster-connection.js';
import { clearSpots, subscribeSpots } from '../lib/spotStore.js';
import {
    cwGraphBand, cwGraphCleared, cwGraphFrequency, openCwGraph, setCwGraphContext,
} from '../compat/cwGraph.js';
import {
    AGE_OPTIONS, AUTO_BAND, BANDS, DEFAULT_AGE_MIN, DEFAULT_FILTERS, DIGITAL_MODES,
    DISTANCE_OPTIONS, SNR_OPTIONS, WPM_OPTIONS,
    ageLabel, countriesIn, filterSpots, modeForSpot, resolveBandFilter, spotMapUrl,
} from '../lib/spots.js';
import { bandForFrequency } from '../lib/bands.js';

// Rows rendered before "show more", and how many each press adds. Kept small
// because this panel is usually a few rows tall in a dock: a page much larger
// than what fits just moves the scrolling from a button press to a long drag,
// and the newest spots — the ones worth seeing — are at the top either way.
const PAGE = 10;

// Ages count up on their own rather than freezing at whatever they read when
// the spot arrived. A second, because the column reads in seconds for the first
// minute and a coarser tick makes it visibly jump — and because the same clock
// drives the age filter, so a spot leaves the list when it actually expires.
// Only a page of rows is mounted, so this is ten-odd cheap re-renders a second.
const AGE_TICK_MS = 1000;

// Which feeds this instance has. The stream names and event names live in
// lib/spotStore.js, which is what actually talks to the socket.
const TABS = [
    { id: 'dx', label: 'DX', requires: (i) => !!(i && i.dx_cluster) },
    { id: 'digital', label: 'Digital', requires: (i) => !!(i && i.digital_decodes) },
    { id: 'cw', label: 'CW', requires: (i) => !!(i && i.cw_skimmer) },
];

export function spotTabs(serverInfo) {
    return TABS.filter((t) => t.requires(serverInfo));
}

function optionLabel(value, unit) {
    return value == null ? 'No limit' : `${value > 0 && unit === 'dB' ? '+' : ''}${value} ${unit}`;
}

function Select({ label, value, onChange, children }) {
    return (
        <label className="spots__filter">
            <span className="spots__filter-label">{label}</span>
            <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
                {children}
            </select>
        </label>
    );
}

// `null` cannot survive a round trip through a <select> value, so the options
// carry '' and it is mapped back on the way out.
const toValue = (v) => (v == null ? '' : String(v));
const fromValue = (v) => (v === '' ? null : Number(v));

function Filters({ tab, filters, set, countries, dialBand }) {
    return (
        <div className="spots__filters">
            <Select label="Age" value={toValue(filters.age)} onChange={(v) => set({ age: fromValue(v) })}>
                {AGE_OPTIONS[tab].map((m) => (
                    <option key={toValue(m)} value={toValue(m)}>{m == null ? 'No limit' : `${m} min`}</option>
                ))}
            </Select>

            {/* Auto first, because it is the default and because it is the answer to the
                question a spot list is usually being asked: who can be heard where I am
                listening. It names the band it has settled on — "Auto (20m)" — so a short
                list is explained by the control rather than being a mystery, and says
                "all bands" where the dial is outside every band, which is most of the
                shortwave spectrum. */}
            <Select label="Band" value={filters.band} onChange={(v) => set({ band: v })}>
                <option value={AUTO_BAND}>
                    {dialBand ? `Auto (${dialBand})` : 'Auto (all bands)'}
                </option>
                <option value="all">All bands</option>
                {BANDS.map((b) => <option key={b} value={b}>{b}</option>)}
            </Select>

            {tab === 'digital' && (
                <Select label="Mode" value={filters.mode} onChange={(v) => set({ mode: v })}>
                    <option value="all">All modes</option>
                    {DIGITAL_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                </Select>
            )}

            {tab !== 'dx' && (
                <Select label="Min SNR" value={toValue(filters.minSnr)} onChange={(v) => set({ minSnr: fromValue(v) })}>
                    {SNR_OPTIONS[tab].map((s) => (
                        <option key={toValue(s)} value={toValue(s)}>{optionLabel(s, 'dB')}</option>
                    ))}
                </Select>
            )}

            {tab === 'cw' && (
                <Select label="Min WPM" value={toValue(filters.minWpm)} onChange={(v) => set({ minWpm: fromValue(v) })}>
                    {WPM_OPTIONS.map((w) => (
                        <option key={toValue(w)} value={toValue(w)}>{optionLabel(w, 'WPM')}</option>
                    ))}
                </Select>
            )}

            {tab !== 'dx' && (
                <Select
                    label="Min distance"
                    value={toValue(filters.minDistance)}
                    onChange={(v) => set({ minDistance: fromValue(v) })}
                >
                    {DISTANCE_OPTIONS.map((d) => (
                        <option key={toValue(d)} value={toValue(d)}>{optionLabel(d, 'km')}</option>
                    ))}
                </Select>
            )}

            <Select label="Country" value={filters.country} onChange={(v) => set({ country: v })}>
                <option value="all">All countries</option>
                {countries.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>

            <label className="spots__filter">
                <span className="spots__filter-label">Callsign</span>
                <input
                    className="input"
                    type="text"
                    placeholder="Filter…"
                    value={filters.callsign}
                    onChange={(e) => set({ callsign: e.target.value })}
                />
            </label>

            {tab === 'cw' && (
                <label className="spots__filter spots__filter--check">
                    <input
                        type="checkbox"
                        checked={filters.tenMeterBeacons}
                        onChange={(e) => set({ tenMeterBeacons: e.target.checked })}
                    />
                    <span>10m beacons</span>
                </label>
            )}
        </div>
    );
}

function Row({ spot, tab, now, tuned, onTune, onLookup, minimal }) {
    const mhz = (spot.frequency / 1e6).toFixed(spot.frequency >= 1e6 ? 4 : 6);
    const flag = countryFlag(spot.countryCode);
    const utc = new Date(spot.at).toISOString().slice(11, 16);

    // Digital rows do not tune. Every station in a decoder band transmits on the
    // same dial frequency — what varies is the audio offset within it — so the
    // frequency on the row is where the station sat in the passband, not
    // somewhere to point the receiver. Tuning there would leave you listening to
    // one corner of an FT8 slot. Same reason these get no spectrum markers.
    const tunes = tab !== 'digital';
    // They do look up, though, where the receiver has a lookup service. A
    // digital row is a callsign and a country and little else, and "who is
    // that" is the only question it raises — it was the one row in the panel
    // that answered nothing at all when pressed. The dial is left exactly where
    // it was, which is the point: the reason not to tune has not changed.
    const looksUp = !tunes && !!onLookup;
    const clickable = tunes || looksUp;

    const title = [
        tunes ? `${mhz} MHz — ${modeForSpot(spot).toUpperCase()}` : `${mhz} MHz`,
        looksUp ? `Look up ${spot.callsign}` : null,
        // Only when the column is not on screen, which is the minimal view —
        // the Age beside it says how long ago, but not at what time.
        minimal ? `${utc} UTC` : null,
        spot.country ? `${spot.callsign} · ${spot.country}` : spot.callsign,
        spot.spotter ? `Spotted by ${spot.spotter}` : null,
        spot.grid ? `Grid ${spot.grid}` : null,
        spot.distanceKm != null ? `${Math.round(spot.distanceKm)} km at ${Math.round(spot.bearingDeg || 0)}°` : null,
        spot.snr != null ? `SNR ${spot.snr} dB` : null,
        spot.wpm != null ? `${spot.wpm} WPM` : null,
        spot.message || spot.comment || null,
    ].filter(Boolean).join('\n');

    const cells = (
        <>
            {!minimal && <span className="spot-row__time">{utc}</span>}
            <span className="spot-row__age">{ageLabel(spot.at, now)}</span>
            <span className="spot-row__freq">{mhz}</span>
            <span className="spot-row__call">{flag ? `${flag} ${spot.callsign}` : spot.callsign}</span>
            {tab === 'digital' && <span className="spot-row__mode">{spot.submode ? `${spot.mode}/${spot.submode}` : spot.mode}</span>}
            {tab === 'cw' && <span className="spot-row__mode">{spot.wpm != null ? `${spot.wpm}` : ''}</span>}
            <span className="spot-row__country">{spot.country}</span>
            {tab !== 'dx' && (
                <span className="spot-row__snr">{spot.snr != null ? `${spot.snr > 0 ? '+' : ''}${spot.snr}` : ''}</span>
            )}
            {tab !== 'dx' && (
                <span className="spot-row__dist">
                    {spot.distanceKm != null ? `${Math.round(spot.distanceKm)}` : ''}
                </span>
            )}
            <span className="spot-row__note">{spot.message || spot.comment || (spot.spotter ? `de ${spot.spotter}` : '')}</span>
        </>
    );

    // A div rather than a disabled button: this is a reading row, not a control
    // that happens to be unavailable, and a disabled button would dim its text
    // and take it out of the accessibility tree.
    if (!clickable) {
        return <div className="list__row spot-row spot-row--static" title={title}>{cells}</div>;
    }

    return (
        <button
            type="button"
            className={`list__row spot-row${tuned && tunes ? ' is-active' : ''}`}
            title={title}
            onClick={() => (tunes ? onTune(spot) : onLookup(spot))}
        >
            {cells}
        </button>
    );
}

// Column headings, in the same grid as the rows so they line up with them — and
// so the numbers underneath have a name. Each carries the cell class its column
// uses, because the numeric columns are right-aligned and a left-aligned heading
// over them would look misaligned even though the grid is not.
const T = 'spot-row__time';
const A = 'spot-row__age';
const F = 'spot-row__freq';
const C = 'spot-row__call';
const N = 'spot-row__mode';       // mode / WPM — a right-aligned narrow column
const S = 'spot-row__snr';
const D = 'spot-row__dist';
const X = 'spot-row__country';
const O = 'spot-row__note';

const HEADINGS = {
    dx: [[T, 'UTC'], [A, 'Age'], [F, 'MHz'], [C, 'Call'], [X, 'Country'], [O, 'Comment']],
    digital: [[T, 'UTC'], [A, 'Age'], [F, 'MHz'], [C, 'Call'], [N, 'Mode'], [X, 'Country'], [S, 'SNR'], [D, 'km'], [O, 'Message']],
    cw: [[T, 'UTC'], [A, 'Age'], [F, 'MHz'], [C, 'Call'], [N, 'WPM'], [X, 'Country'], [S, 'SNR'], [D, 'km'], [O, 'Spotter']],
};

function Head({ tab, minimal }) {
    return (
        <div className="spot-row spot-row--head" aria-hidden="true">
            {HEADINGS[tab]
                .filter(([cls]) => !(minimal && cls === T))
                .map(([cls, label]) => <span key={label} className={cls}>{label}</span>)}
        </div>
    );
}

// `minimal` keeps the list and drops what is around it: the filter row, the UTC
// column, and the CW tab's Graph button.
//
// The time goes because Age is right beside it saying the same thing in the
// form you actually read — "4m" rather than a clock you have to subtract from —
// and because it is 38px of a panel that has none to spare. The exact time
// moves into the row's tooltip rather than being lost.
//
// The filters stay in force — hiding a control does not undo it — and the count
// above the list keeps reading "N of M" whenever they are narrowing anything,
// so a short list is never a mystery. See the registry's `minimal`.
export default function SpotsPanel({ minimal }) {
    const { serverInfo, tuning, actions, running } = useRadio();
    const { sections } = useLayout();

    const tabs = useMemo(() => spotTabs(serverInfo), [serverInfo]);
    const [tab, setTab] = useState(() => (tabs[0] ? tabs[0].id : 'dx'));
    // The selected tab can vanish when /api/description arrives late or the
    // operator turns a feed off.
    const active = tabs.some((t) => t.id === tab) ? tab : (tabs[0] && tabs[0].id);

    const [spots, setSpots] = useState([]);
    const [filters, setFilters] = useState(() => ({
        dx: { ...DEFAULT_FILTERS, age: DEFAULT_AGE_MIN.dx },
        digital: { ...DEFAULT_FILTERS, age: DEFAULT_AGE_MIN.digital },
        cw: { ...DEFAULT_FILTERS, age: DEFAULT_AGE_MIN.cw },
    }));
    const [shown, setShown] = useState(PAGE);
    const [now, setNow] = useState(() => Date.now());
    const [state, setState] = useState(dxcluster.state);

    const hidden = !!(sections.spots && sections.spots.hidden);
    // Subscribing needs a registered session, which only exists once the
    // receiver has been started — the same gate chat uses, and for the same
    // reason: no point holding this socket open for someone who is not here.
    const live = !!active && running && !hidden;

    useEffect(() => {
        const off = dxcluster.on('state', setState);
        setState(dxcluster.state);
        return off;
    }, []);

    // One subscription, for the visible tab only — the markers hold their own,
    // and the store shares whatever overlaps. Switching tabs re-subscribes,
    // which replays that stream's server-side buffer, so the history comes back.
    useEffect(() => {
        if (!live) { setSpots([]); return undefined; }
        return subscribeSpots(active, setSpots);
    }, [live, active]);

    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
        return () => clearInterval(id);
    }, []);

    // A filter change should show the top of the new list, not page 4 of it.
    useEffect(() => { setShown(PAGE); }, [active, filters]);

    // What the CW graph reads back off us — everything except the spots, which
    // it subscribes to itself. Refreshed on every render rather than captured
    // once: the panel is unmounted whenever its section is collapsed, and the
    // graph has to keep working through that.
    setCwGraphContext({
        // Resolved, never 'auto': v1's graph takes a band name or 'all', and handing it
        // a word it has never heard of would filter to nothing.
        band: () => resolveBandFilter(filters.cw.band, bandForFrequency(tuning.frequency)),
        frequency: () => tuning.frequency,
        lookups: () => !!(serverInfo && serverInfo.lookup_service),
        uuid: () => getSessionId(),
        tune: (t) => actions.tuneTo(t),
        lookup: (call) => { if (!requestLookup(call)) lookupCallsign(call); },
        clear: () => clearSpots('cw'),
    });

    // The graph mirrors our band filter and follows the dial for its
    // auto-lookup. Both are no-ops when it is not open.
    // Resolved for the same reason, and re-pushed when the dial changes band as well as
    // when the filter does: on auto, moving to another band is a change of filter.
    useEffect(() => {
        cwGraphBand(resolveBandFilter(filters.cw.band, bandForFrequency(tuning.frequency)));
    }, [filters.cw.band, tuning.frequency]);
    useEffect(() => { cwGraphFrequency(tuning.frequency); }, [tuning.frequency]);

    if (!tabs.length) return <Empty>This receiver publishes no spots.</Empty>;

    const list = spots;
    const f = filters[active];
    // The band the dial is in, for the 'auto' band filter — see bandFilter. Worked out
    // here rather than inside the filter so the picker can say which band auto has
    // landed on, which is the difference between a filter you trust and one that seems
    // to be hiding things.
    const dialBand = bandForFrequency(tuning.frequency);
    const matched = filterSpots(list, f, now, dialBand);
    const countries = countriesIn(list);
    const page = matched.slice(0, shown);

    const set = (patch) => setFilters((prev) => ({ ...prev, [active]: { ...prev[active], ...patch } }));

    // The spot whose map is open, if any. A modal rather than a panel: it is a
    // detour from a list — you came to read the decodes and stopped to ask about
    // one — and a detour that rearranged the panel would lose your place in the
    // thing you were reading.
    const [mapped, setMapped] = useState(null);

    // Whether there is anywhere to send a callsign. The same gate the CW graph's
    // context uses, and the same one the Callsign panel's `requires` uses to
    // exist at all.
    const lookups = !!(serverInfo && serverInfo.lookup_service);

    // Where a spot's callsign goes. The in-app panel wins when it is open;
    // otherwise the v1 popup gets it, if *that* is open. Neither is ever opened
    // by a click here — a row press that spawned a window would be a row press
    // nobody would risk twice.
    const lookup = (call) => {
        if (!lookups || !call) return;
        if (!requestLookup(call)) lookupCallsign(call);
    };

    const tune = (spot) => {
        // One tune rather than a mode change that resets the passband followed
        // by a frequency change — the v1 extensions pass preserveBandwidth=false
        // for the same reason, so the row lands on the mode's own filter.
        actions.tuneTo({ frequency: Math.round(spot.frequency), mode: modeForSpot(spot) });
        // And look the callsign up, as the v1 rows do.
        lookup(spot.callsign);
    };

    return (
        <div className="stack spots">
            {mapped && (
                <SpotMap spot={mapped} lookups={lookups} onClose={() => setMapped(null)} />
            )}
            <div className="spots__head">
                {tabs.length > 1 && (
                    <Segmented
                        options={tabs.map((t) => ({ value: t.id, label: t.label }))}
                        value={active}
                        onChange={setTab}
                        size="sm"
                    />
                )}
                <span className="spots__count">
                    {matched.length === list.length
                        ? `${list.length} spot${list.length === 1 ? '' : 's'}`
                        : `${matched.length} of ${list.length}`}
                </span>
                {/* v1 ships this as the CW skimmer extension's "View Spots"
                    button. The page is a chart of the same spots over time,
                    with its own filters, map and morse decoder — see
                    compat/cwGraph.js for what it expects from us.

                    Not in the minimal view: it opens a whole second window, so
                    it belongs with the setup this view drops rather than with
                    the list it keeps — and its label is the widest thing in a
                    row that has the spot count to fit as well. */}
                {active === 'cw' && !minimal && (
                    <Button
                        size="sm"
                        variant="ghost"
                        icon={<Icon.External size={13} />}
                        title="Open the CW spot graph"
                        onClick={() => openCwGraph((fn) => subscribeSpots('cw', fn))}
                    >
                        Graph
                    </Button>
                )}
                <Button
                    size="sm"
                    variant="ghost"
                    icon={<Icon.Trash size={13} />}
                    title="Clear the list"
                    disabled={!list.length}
                    onClick={() => {
                        clearSpots(active);
                        // The graph holds its own copy, so it has to be told.
                        if (active === 'cw') cwGraphCleared();
                    }}
                />
            </div>

            {!running && <div className="note note--tight">Start listening to receive spots.</div>}
            {running && state === 'reconnecting' && <div className="note note--warn">Reconnecting…</div>}

            {!minimal && (
                <Filters tab={active} filters={f} set={set} countries={countries} dialBand={dialBand} />
            )}

            <div className={`list spots__list spots__list--${active}${minimal ? ' spots__list--min' : ''}`}>
                {page.length === 0 && (
                    <Empty>
                        {list.length === 0
                            ? (running ? 'Waiting for spots…' : 'Not connected.')
                            : 'No spots match these filters.'}
                    </Empty>
                )}
                {page.length > 0 && <Head tab={active} minimal={minimal} />}
                {page.map((spot) => (
                    <Row
                        key={spot.key}
                        spot={spot}
                        tab={active}
                        now={now}
                        tuned={Math.abs(spot.frequency - tuning.frequency) < 200}
                        onTune={tune}
                        // Only where there is a lookup service to ask. Without
                        // one a digital row goes back to being a reading row
                        // rather than a button that does nothing.
                        //
                        // Offered on more than lookups alone: without a lookup
                        // service the map still has the locator the decoder
                        // reported and the country its prefix implies, which is
                        // the whole of what a digital row knows about a station
                        // and more than the row itself can show.
                        onLookup={lookups || spot.grid ? (s2) => {
                            lookup(s2.callsign);
                            setMapped(s2);
                        } : null}
                        minimal={minimal}
                    />
                ))}
            </div>

            {/* The shared control rather than a hand-rolled button, so this list shrinks
                again like the others do. `count` off: a spot list is a feed, and "412 shown"
                under it is a number about the filter rather than about the spots. */}
            <ShowMore
                shown={page.length}
                total={matched.length}
                base={PAGE}
                count={false}
                onMore={() => setShown((n) => n + PAGE)}
                onLess={() => setShown(PAGE)}
            />

            {/* The feed's own live map — v1's page, which plots these spots on a world map
                with the greyline and a track per station. At the bottom because it is
                where you go when the list has told you something worth looking at
                properly, and a link out belongs after the thing it is about rather than
                above it.

                Only the two feeds that have one: there is no cluster map to open, and a
                button that goes nowhere is worse than no button. Not in the minimal view
                either — it opens a whole second window, which is not what a panel cut down
                to a list is for. */}
            {!minimal && spotMapUrl(active) && (
                <div className="row-end">
                    <a
                        className="btn btn--ghost btn--sm"
                        href={spotMapUrl(active)}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        Open map
                        <Icon.External size={13} />
                    </a>
                </div>
            )}
        </div>
    );
}
