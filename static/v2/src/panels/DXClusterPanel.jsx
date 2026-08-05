// The DX cluster addon, natively.
//
// The addon ships its own page at /addon/dxcluster/ and this is the same feed
// in this interface instead of a second one in another tab: the spots tune the
// receiver you are looking at, the filters use the same controls as every other
// panel, and it goes wherever you put it.
//
// The connection is the panel's lifetime. Panels are unmounted when collapsed
// or hidden, so opening this one opens the feed and closing it closes it —
// nothing is held open for a panel nobody has on screen.
//
// `minimal` keeps the spot list and drops the filters and the status line.

import React, { useCallback, useEffect, useMemo, useRef, useState } from '../react.js';
import { Button, Empty, Field, Icon, ShowMore } from '../components/ui.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { formatFreqShort } from '../lib/format.js';
import {
    ALL_MODES, DEFAULT_FILTERS, STREAMS, bandsIn, continentsIn, countriesIn,
    dialFreq, modeOf, spotKey, spotMatches, streamMeta, streamOf,
} from '../lib/dxcluster.js';
import { openFeed } from '../lib/dxclusterFeed.js';

const PAGE = 25;

// Ages tick rather than freezing at whatever they read when the spot arrived.
const AGE_TICK_MS = 1000;

function ago(iso, now) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '—';
    const s = Math.max(0, Math.round((now - t) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h`;
}

const utc = (iso) => {
    const t = new Date(iso);
    return Number.isNaN(t.getTime()) ? '—' : t.toISOString().slice(11, 16);
};

// A multi-select that stays a row of chips rather than becoming a <select
// multiple>, which is unusable in a dock and worse on touch.
function ChipPicker({ label, options, value, onChange, empty = 'All' }) {
    if (!options.length) return null;
    const toggle = (v) => {
        const next = value.includes(v) ? value.filter((x) => x !== v) : [...value, v];
        onChange(next);
    };
    return (
        <div className="dxc-picker">
            <span className="dxc-picker__label">
                {label}
                {value.length === 0 && <span className="dxc-picker__all">{empty}</span>}
            </span>
            <div className="chip-row chip-row--wrap">
                {options.map((o) => {
                    const v = typeof o === 'string' ? o : o.value;
                    const text = typeof o === 'string' ? o : o.label;
                    return (
                        <button
                            key={v}
                            type="button"
                            className={`chip chip--button${value.includes(v) ? ' is-on' : ''}`}
                            onClick={() => toggle(v)}
                        >
                            {text}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

export default function DXClusterPanel({ minimal }) {
    const { actions } = useRadio();
    const [spots, setSpots] = useState([]);
    const [status, setStatus] = useState(null);
    const [state, setState] = useState('connecting');
    const [filters, setFilters] = useState(DEFAULT_FILTERS);
    const [limit, setLimit] = useState(PAGE);
    const [showFilters, setShowFilters] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    const feedRef = useRef(null);

    // The whole point of the lifecycle: mounted means somebody is looking.
    useEffect(() => {
        const feed = openFeed({ spots: setSpots, status: setStatus, state: setState });
        feedRef.current = feed;
        return () => {
            feed.close();
            feedRef.current = null;
        };
    }, []);

    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
        return () => clearInterval(id);
    }, []);

    useEffect(() => { setLimit(PAGE); }, [filters]);

    const set = useCallback((patch) => setFilters((f) => ({ ...f, ...patch })), []);

    const bands = useMemo(() => bandsIn(spots), [spots]);
    const continents = useMemo(() => continentsIn(spots), [spots]);
    const countries = useMemo(() => countriesIn(spots), [spots]);
    const shown = useMemo(() => spots.filter((s) => spotMatches(s, filters)), [spots, filters]);

    const tune = (spot) => {
        const hz = dialFreq(spot);
        if (hz == null) return;
        const mode = modeOf(spot);
        // Digital and CW decodes carry a mode worth switching to; a cluster spot
        // does not, and guessing one from the band plan is how you end up in the
        // wrong sideband on 40 m.
        if (mode === 'USB' || mode === 'LSB') actions.tuneTo({ frequency: hz, mode: mode.toLowerCase() });
        else actions.setFrequency(hz);
        actions.ensureVisible(hz);
    };

    const conn = state === 'live' ? 'good' : state === 'connecting' ? 'warn' : 'bad';

    return (
        <div className="stack">
            {!minimal && (
                <div className="dxc-head">
                    <span className={`dot dot--${conn}`} />
                    <span className="dxc-head__state">
                        {state === 'live' ? 'Live' : state === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
                    </span>
                    {status && status.telnet_addr && (
                        <span className="tag tag--ghost" title="Telnet address of this cluster">
                            telnet {status.telnet_addr}
                        </span>
                    )}
                    {status && status.telnet_clients > 0 && (
                        <span
                            className="tag"
                            title={(status.telnet_client_list || [])
                                .map((c) => `${c.callsign || c.ip}`).join(', ')}
                        >
                            {status.telnet_clients} logged in
                        </span>
                    )}
                    <span className="dxc-head__count">{shown.length}</span>
                </div>
            )}

            {!minimal && (
                <div className="chip-row chip-row--wrap">
                    {STREAMS.map((s) => (
                        <button
                            key={s.id}
                            type="button"
                            className={`chip chip--button${filters.streams.includes(s.id) ? ' is-on' : ''}`}
                            title={`Show ${s.label} spots`}
                            onClick={() => set({
                                streams: filters.streams.includes(s.id)
                                    ? filters.streams.filter((x) => x !== s.id)
                                    : [...filters.streams, s.id],
                            })}
                        >
                            {s.label}
                        </button>
                    ))}
                    <Button
                        size="sm"
                        variant="ghost"
                        active={showFilters}
                        onClick={() => setShowFilters((v) => !v)}
                    >
                        Filters
                    </Button>
                </div>
            )}

            {!minimal && showFilters && (
                <div className="dxc-filters">
                    <Field label="Callsign starts with">
                        <input
                            className="input"
                            placeholder="e.g. G, EA, VK3"
                            value={filters.call}
                            onChange={(e) => set({ call: e.target.value })}
                        />
                    </Field>
                    <ChipPicker
                        label="Mode"
                        options={ALL_MODES}
                        value={filters.modes.length === ALL_MODES.length ? [] : filters.modes}
                        onChange={(v) => set({ modes: v.length ? v : ALL_MODES })}
                    />
                    <ChipPicker label="Band" options={bands} value={filters.bands}
                        onChange={(v) => set({ bands: v })} />
                    <ChipPicker label="Continent" options={continents} value={filters.continents}
                        onChange={(v) => set({ continents: v })} />
                    <ChipPicker
                        label="Country"
                        options={countries.map((c) => ({ value: c.code, label: c.name }))}
                        value={filters.countries}
                        onChange={(v) => set({ countries: v })}
                    />
                    <div className="row-end">
                        <Button size="sm" variant="ghost" icon={<Icon.Reset size={13} />}
                            onClick={() => setFilters(DEFAULT_FILTERS)}>
                            Clear filters
                        </Button>
                    </div>
                </div>
            )}

            {shown.length === 0 ? (
                <Empty>
                    {spots.length === 0
                        ? (state === 'down' ? 'No connection to the cluster addon.' : 'Waiting for spots…')
                        : 'No spot matches these filters'}
                </Empty>
            ) : (
                <div className="dxc-list">
                    {shown.slice(0, limit).map((spot) => {
                        const meta = streamMeta(streamOf(spot));
                        const mode = modeOf(spot);
                        const snr = Number(spot.snr);
                        return (
                            <button
                                type="button"
                                key={spotKey(spot)}
                                className="dxc-row"
                                onClick={() => tune(spot)}
                                title={spot.comment || `Spotted by ${spot.spotter || '—'}`}
                            >
                                {!minimal && <span className="dxc-row__utc">{utc(spot.timestamp)}</span>}
                                <span className={`dxc-row__type dxc-row__type--${meta.tone}`}>{meta.label}</span>
                                <span className="dxc-row__call">{spot.callsign || '—'}</span>
                                <span className="dxc-row__freq">{formatFreqShort(dialFreq(spot) || 0)}</span>
                                {!minimal && <span className="dxc-row__band">{spot.band || ''}</span>}
                                {!minimal && <span className="dxc-row__mode">{mode}</span>}
                                {!minimal && (
                                    <span className="dxc-row__snr">
                                        {Number.isFinite(snr) ? `${snr > 0 ? '+' : ''}${snr} dB` : ''}
                                    </span>
                                )}
                                <span className="dxc-row__country">{spot.country || ''}</span>
                                <span className="dxc-row__age">{ago(spot.timestamp, now)}</span>
                            </button>
                        );
                    })}
                </div>
            )}

            {shown.length > limit && (
                <ShowMore
                    shown={limit}
                    total={shown.length}
                    onMore={() => setLimit((n) => n + PAGE)}
                    label="Show more spots"
                />
            )}

            {!minimal && (
                <div className="note note--tight">
                    From the DX cluster addon on this receiver — its own spots, this
                    receiver&apos;s decoders, and the wider cluster network. Clicking a spot
                    tunes to it; digital decodes tune to the dial frequency rather than to the
                    tone. <a href={`/addon/dxcluster/`} target="_blank" rel="noopener noreferrer">
                        The addon&apos;s own page
                    </a> has the telnet terminal.
                </div>
            )}
        </div>
    );
}
