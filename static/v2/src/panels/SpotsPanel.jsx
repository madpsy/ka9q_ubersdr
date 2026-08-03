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
import { Button, Empty, Icon, Segmented } from '../components/ui.jsx';
import { countryFlag } from '../lib/format.js';
import { lookupCallsign } from '../compat/legacyBridge.js';
import { requestLookup } from '../lib/callsign.js';
import { dxcluster } from '../radio/dxcluster-connection.js';
import { clearSpots, subscribeSpots } from '../lib/spotStore.js';
import {
    AGE_OPTIONS, BANDS, DEFAULT_AGE_MIN, DEFAULT_FILTERS, DIGITAL_MODES,
    DISTANCE_OPTIONS, SNR_OPTIONS, WPM_OPTIONS,
    ageLabel, countriesIn, filterSpots, modeForSpot,
} from '../lib/spots.js';

// Rows rendered before "show more", and how many each press adds. Kept small
// because this panel is usually a few rows tall in a dock: a page much larger
// than what fits just moves the scrolling from a button press to a long drag,
// and the newest spots — the ones worth seeing — are at the top either way.
const PAGE = 10;

// Ages tick over on their own, so the list re-renders on a slow clock rather
// than per spot. One second would be needless work for a column that reads in
// minutes; ten is fast enough that nothing looks stuck.
const AGE_TICK_MS = 10000;

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

function Filters({ tab, filters, set, countries }) {
    return (
        <div className="spots__filters">
            <Select label="Age" value={toValue(filters.age)} onChange={(v) => set({ age: fromValue(v) })}>
                {AGE_OPTIONS[tab].map((m) => (
                    <option key={toValue(m)} value={toValue(m)}>{m == null ? 'No limit' : `${m} min`}</option>
                ))}
            </Select>

            <Select label="Band" value={filters.band} onChange={(v) => set({ band: v })}>
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

function Row({ spot, tab, now, tuned, onTune }) {
    const mhz = (spot.frequency / 1e6).toFixed(spot.frequency >= 1e6 ? 4 : 6);
    const flag = countryFlag(spot.countryCode);
    const utc = new Date(spot.at).toISOString().slice(11, 16);

    // Digital rows do not tune. Every station in a decoder band transmits on the
    // same dial frequency — what varies is the audio offset within it — so the
    // frequency on the row is where the station sat in the passband, not
    // somewhere to point the receiver. Tuning there would leave you listening to
    // one corner of an FT8 slot. Same reason these get no spectrum markers.
    const clickable = tab !== 'digital';

    const title = [
        clickable ? `${mhz} MHz — ${modeForSpot(spot).toUpperCase()}` : `${mhz} MHz`,
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
            <span className="spot-row__time">{utc}</span>
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
            className={`list__row spot-row${tuned ? ' is-active' : ''}`}
            title={title}
            onClick={() => onTune(spot)}
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

function Head({ tab }) {
    return (
        <div className="spot-row spot-row--head" aria-hidden="true">
            {HEADINGS[tab].map(([cls, label]) => <span key={label} className={cls}>{label}</span>)}
        </div>
    );
}

export default function SpotsPanel() {
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

    if (!tabs.length) return <Empty>This receiver publishes no spots.</Empty>;

    const list = spots;
    const f = filters[active];
    const matched = filterSpots(list, f, now);
    const countries = countriesIn(list);
    const page = matched.slice(0, shown);

    const set = (patch) => setFilters((prev) => ({ ...prev, [active]: { ...prev[active], ...patch } }));

    const tune = (spot) => {
        // One tune rather than a mode change that resets the passband followed
        // by a frequency change — the v1 extensions pass preserveBandwidth=false
        // for the same reason, so the row lands on the mode's own filter.
        actions.tuneTo({ frequency: Math.round(spot.frequency), mode: modeForSpot(spot) });
        // And look the callsign up, as the v1 rows do. The in-app panel wins
        // when it is open; otherwise the v1 popup gets it, if that is open.
        // Neither is ever opened by a click here.
        const call = spot.callsign;
        if (serverInfo && serverInfo.lookup_service && call && !requestLookup(call)) lookupCallsign(call);
    };

    return (
        <div className="stack spots">
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
                <Button
                    size="sm"
                    variant="ghost"
                    icon={<Icon.Trash size={13} />}
                    title="Clear the list"
                    disabled={!list.length}
                    onClick={() => clearSpots(active)}
                />
            </div>

            {!running && <div className="note note--tight">Start listening to receive spots.</div>}
            {running && state === 'reconnecting' && <div className="note note--warn">Reconnecting…</div>}

            <Filters tab={active} filters={f} set={set} countries={countries} />

            <div className={`list spots__list spots__list--${active}`}>
                {page.length === 0 && (
                    <Empty>
                        {list.length === 0
                            ? (running ? 'Waiting for spots…' : 'Not connected.')
                            : 'No spots match these filters.'}
                    </Empty>
                )}
                {page.length > 0 && <Head tab={active} />}
                {page.map((spot) => (
                    <Row
                        key={spot.key}
                        spot={spot}
                        tab={active}
                        now={now}
                        tuned={Math.abs(spot.frequency - tuning.frequency) < 200}
                        onTune={tune}
                    />
                ))}
            </div>

            {shown < matched.length && (
                <button type="button" className="show-more" onClick={() => setShown((n) => n + PAGE)}>
                    Show more <span className="show-more__count">{page.length} of {matched.length}</span>
                </button>
            )}
        </div>
    );
}
