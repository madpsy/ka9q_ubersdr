// Which NCDXF/IARU beacons this receiver has heard, and on what.
//
// static/ncdxf_beacons.html compressed into a dock column, on the same two
// endpoints — see lib/ncdxf.js, which holds the fetching and all the shaping.
// That page is a survey you go and look at; this is the one question worth
// having beside the dial, which is whether the bands are open and in which
// directions.
//
// ── The shape of a row ──────────────────────────────────────────────────────
//
// Five pips per row, one per beacon band in slot order, filled where that
// beacon was heard and tinted by how strongly. That is the compact form of an
// 18 × 5 grid: the grid answers "who, where" in a shape a dock column cannot
// hold, and a row of five cells answers it a beacon at a time. Under the rows,
// the same five bands summed the other way — how many of the eighteen each band
// brought in — because the band you have pinned being the wrong one is exactly
// what a beacon panel should be able to tell you.
//
// ── The two controls ────────────────────────────────────────────────────────
//
// A window, defaulting to the last hour, and a band filter that follows the
// dial. Both are the ones the Spots panel has, worded the same way, and the
// band filter is resolved by lib/ncdxf.js `resolveBeaconBand` rather than the
// shared one — a beacon panel only knows five bands and Auto has to fall back
// to all of them anywhere else. Selecting a band promotes that band's figures
// onto every row, because a list labelled with decodes it is not showing is
// worse than no labels.
//
// Changing the window refetches; changing the band does not. Everything the
// filter needs is already in the response, so the dial can move as often as it
// likes for free.
//
// ── Gating and cost ─────────────────────────────────────────────────────────
//
// Present whenever the receiver has a CW skimmer, empty state and all: a
// skimmer that does not cover 14.100 / 18.110 / 21.150 / 24.930 / 28.200 will
// never hear a beacon, and a panel that says so is more use than one that is
// silently missing. It costs nothing until it is opened — the panel ships
// collapsed and Section does not mount a closed body — and once open it is one
// request every fifteen minutes.
//
// `minimal` is the rows and nothing else: no controls, no band strip, no
// footer, no map. What survives is the answer, which is which beacons are
// audible right now.

import React, { useEffect, useMemo, useState } from '../react.js';
import { Button, Empty, Icon, Modal, ShowMore } from '../components/ui.jsx';
import BeaconMap from '../components/BeaconMap.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { AUTO_BAND, bandForFrequency } from '../lib/bands.js';
import { countryFlag, freqInRange, snrColour } from '../lib/format.js';
import { ageLabel } from '../lib/spots.js';
import {
    BEACON_BANDS, BEACON_COUNT, WINDOWS,
    bandSummary, beaconRange, beaconTarget, ncdxfState, notHeard, onNcdxf,
    pollNcdxf, receiverAt, refreshNcdxf, resolveBeaconBand, rowsForBand,
    savePrefs, savedPrefs, snrLabel, statsFor, windowLabel,
} from '../lib/ncdxf.js';

// The full page, for the questions a dock column cannot answer: a day of
// history per band, and a replay of the last 24 hours.
const PAGE_URL = '/ncdxf_beacons.html';

// Rows before the pager, and all a cut-down view ever shows. Six is a third of
// the network, which on an open band is about what a receiver hears.
const PAGE = 6;

// The ages are redrawn on this rather than on the poll, or a fifteen-minute-old
// reading would go on claiming to be two minutes old for another fourteen.
// Every figure here is in whole minutes, so ten seconds is already finer than
// anything on screen.
const TICK_MS = 10000;

/** The window and band pickers, in the Spots panel's own markup. */
function Select({ label, value, onChange, children }) {
    return (
        <label className="ncdxf__filter">
            <span className="ncdxf__filter-label">{label}</span>
            <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
                {children}
            </select>
        </label>
    );
}

/**
 * The band picker, shared by the panel and its map so the two cannot disagree
 * about which band is being looked at.
 *
 * Auto names the band it has settled on — "Auto (20m)" — and says "all bands"
 * where the dial is outside the five, which is most of the spectrum. Same
 * wording as the spot filters, and the same reason: a short list should be
 * explained by the control rather than being a mystery.
 */
export function BandPicker({ value, dialBand, onChange }) {
    const auto = resolveBeaconBand(AUTO_BAND, dialBand);
    return (
        <Select label="Band" value={value} onChange={onChange}>
            <option value={AUTO_BAND}>
                {auto === 'all' ? 'Auto (all bands)' : `Auto (${auto})`}
            </option>
            <option value="all">All bands</option>
            {BEACON_BANDS.map((b) => <option key={b} value={b}>{b}</option>)}
        </Select>
    );
}

/**
 * One beacon's five bands.
 *
 * Fixed cells in fixed positions, so the same band is always in the same place
 * down the list and the shape of a column is readable on its own — a filled
 * left-hand column is 20m open to everywhere, and the eye finds that without
 * reading a single callsign. Colour is lib/format.js `snrColour`, the scale the
 * whole app paints a signal-to-noise ratio with.
 */
function Pips({ row, selected }) {
    return (
        <span className="ncdxf-pips">
            {BEACON_BANDS.map((band) => {
                const cell = row.bands[band];
                const on = !!cell;
                const dim = on && selected && selected !== 'all' && selected !== band;
                return (
                    <span
                        key={band}
                        className={`ncdxf-pip${on ? ' is-on' : ''}${dim ? ' is-dim' : ''}`}
                        style={on ? { background: snrColour(cell.snr) } : undefined}
                        title={on
                            ? `${band} — last ${snrLabel(cell.snr)}, ${cell.count} decode${cell.count === 1 ? '' : 's'}`
                            : `${band} — not heard`}
                    />
                );
            })}
        </span>
    );
}

/**
 * The five bands summed the other way: how many of the eighteen each one
 * brought in. Always every band, whatever the filter — this strip is how
 * somebody notices that the band they have pinned is not the open one.
 *
 * A cell is the filter: pressing one pins that band, pressing the pinned one
 * gives it back to Auto. It is not a tuning control, which is the row's job —
 * a cell that both selected and tuned would do two things to one press.
 */
function BandStrip({ summary, selected, onPick }) {
    return (
        <div className="ncdxf-strip">
            {summary.map((cell) => {
                const on = cell.beacons > 0;
                const active = selected === cell.band;
                return (
                    <button
                        type="button"
                        key={cell.band}
                        className={`ncdxf-strip__cell${on ? ' is-on' : ''}${active ? ' is-active' : ''}`}
                        title={on
                            ? `${cell.band}: ${cell.beacons} of ${BEACON_COUNT} beacons, ${cell.spots} decodes`
                                + `\nStrongest ${cell.call} ${snrLabel(cell.snr)}`
                                + `\nClick to show only ${cell.band}`
                            : `${cell.band}: no beacons heard`}
                        onClick={() => onPick(active ? AUTO_BAND : cell.band)}
                    >
                        <span className="ncdxf-strip__band">{cell.band}</span>
                        <span className="ncdxf-strip__bar">
                            <span
                                className="ncdxf-strip__fill"
                                style={{
                                    width: `${Math.round((cell.beacons / BEACON_COUNT) * 100)}%`,
                                    background: on ? snrColour(cell.snr) : 'transparent',
                                }}
                            />
                        </span>
                        <span className="ncdxf-strip__count">{on ? cell.beacons : '·'}</span>
                    </button>
                );
            })}
        </div>
    );
}

/**
 * One beacon.
 *
 * Two lines on the DXpeditions pattern, each its own flex row, so the location
 * on the first cannot be squeezed off the end by the figures on the second.
 *
 * Pressing it tunes to the band it was last heard on — exactly, since a beacon
 * frequency is published rather than measured — in upper-sideband CW. With a
 * band pinned that is always the pinned band, which is what makes "pin 15m,
 * press a row" mean "listen to 15m beacons".
 */
function Row({ row, beacon, rx, selected, now, tunes, onTune }) {
    const range = beaconRange(rx, beacon);
    const flag = beacon ? countryFlag(beacon.countryCode) : '';
    const where = beacon ? [flag, beacon.location || beacon.entity].filter(Boolean).join(' ') : '';
    const target = beaconTarget(row.lastBand);
    const can = tunes && !!target && freqInRange(target.frequency);

    const title = [
        `${row.call}${beacon && beacon.entity ? ` — ${beacon.entity}` : ''}`,
        beacon && beacon.grid ? `${beacon.location} · ${beacon.grid}` : '',
        range ? `${range.distKm.toLocaleString()} km · bearing ${String(range.bearing).padStart(3, '0')}°` : '',
        BEACON_BANDS
            .filter((b) => row.bands[b])
            .map((b) => `${b} last ${snrLabel(row.bands[b].snr)} · ${row.bands[b].count}× · ${ageLabel(row.bands[b].at, now)} ago`)
            .join('\n'),
        can ? `Click to tune ${row.lastBand} beacons — ${(target.frequency / 1e6).toFixed(3)} MHz CW` : '',
    ].filter(Boolean).join('\n');

    return (
        <button
            type="button"
            className={`list__row ncdxf-row${can ? '' : ' is-flat'}`}
            title={title}
            disabled={!can}
            onClick={() => can && onTune(target)}
        >
            <span className="ncdxf-row__line">
                <span className="ncdxf-row__call">{row.call}</span>
                <span className="ncdxf-row__where">{where}</span>
            </span>
            <span className="ncdxf-row__line">
                <Pips row={row} selected={selected} />
                <span className="ncdxf-row__snr" style={{ color: snrColour(row.snr) }}>
                    {snrLabel(row.snr)}
                </span>
                <span className="ncdxf-row__detail">{`${row.lastBand} · ${row.count}×`}</span>
                <span className="ncdxf-row__age">{ageLabel(row.at, now)}</span>
            </span>
        </button>
    );
}

export default function NCDXFPanel({ minimal }) {
    const { serverInfo, tuning, actions, running } = useRadio();

    const [prefs, setPrefs] = useState(savedPrefs);
    const [state, setState] = useState(ncdxfState);
    const [shown, setShown] = useState(PAGE);
    const [mapOpen, setMapOpen] = useState(false);
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => onNcdxf(setState), []);

    // Loaded on mount so the panel works before Start — a one-shot load is not
    // a feed, the carve-out lib/serverFeeds.js names — and polled after that,
    // which is gated. The store's own floor is what stops the two from being
    // two requests: feedInterval fires immediately when the gate opens, a
    // moment after the mount load has already been stamped.
    useEffect(() => {
        refreshNcdxf(prefs.window);
        return pollNcdxf(prefs.window);
    }, [prefs.window]);

    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), TICK_MS);
        return () => clearInterval(id);
    }, []);

    const set = (next) => {
        const merged = { ...prefs, ...next };
        savePrefs(merged);
        setPrefs(merged);
        // A different band is a different list, and a window six presses down
        // the old one says nothing about the new one.
        setShown(PAGE);
    };

    const dialBand = bandForFrequency(tuning.frequency);
    const band = resolveBeaconBand(prefs.band, dialBand);

    const rows = useMemo(() => rowsForBand(state.rows, band), [state.rows, band]);
    const summary = useMemo(() => bandSummary(state.rows), [state.rows]);
    const silent = useMemo(() => notHeard(state.roster, rows), [state.roster, rows]);
    const rx = useMemo(
        () => receiverAt(serverInfo && serverInfo.receiver),
        [serverInfo],
    );
    const stats = useMemo(
        () => statsFor(rows, state.roster, rx, band),
        [rows, state.roster, rx, band],
    );
    const byCall = useMemo(
        () => new Map(state.roster.map((b) => [b.callsign, b])),
        [state.roster],
    );

    const page = rows.slice(0, minimal ? PAGE : shown);
    const tune = (target) => { if (target) actions.tuneTo(target); };
    const heardOn = band === 'all' ? '' : ` on ${band}`;

    // Why the list is empty, which is the whole of what this panel has to say
    // on a quiet band and is two quite different sentences. A filter hiding
    // decodes that exist is the operator's own doing and is fixed by one click;
    // nothing anywhere is either the bands or — far more likely, and something
    // nobody would guess from an empty list — a skimmer that is not listening
    // on the beacon frequencies at all.
    const emptyNote = state.rows.length > 0
        ? `No beacons heard${heardOn} in ${windowLabel(prefs.window)}.`
            + ' Another band has them — clear the band filter.'
        : `No beacons heard${heardOn} in ${windowLabel(prefs.window)}.`
            + ' The bands may be closed, or the skimmer may not cover'
            + ' 14.100 · 18.110 · 21.150 · 24.930 · 28.200 MHz.';

    return (
        <div className="stack">
            {!minimal && (
                <div className="ncdxf__filters">
                    <Select
                        label="Window"
                        value={String(prefs.window)}
                        onChange={(v) => set({ window: Number(v) })}
                    >
                        {WINDOWS.map((w) => (
                            <option key={w.minutes} value={String(w.minutes)}>{w.label}</option>
                        ))}
                    </Select>
                    <BandPicker
                        value={prefs.band}
                        dialBand={dialBand}
                        onChange={(v) => set({ band: v })}
                    />
                    <span className="ncdxf__count">
                        {state.loading ? 'Loading…' : `${rows.length}/${BEACON_COUNT}`}
                    </span>
                </div>
            )}

            {!minimal && !state.off && !state.error && (
                <BandStrip
                    summary={summary}
                    selected={band}
                    onPick={(v) => set({ band: v })}
                />
            )}

            {state.off && (
                <Empty>CW spot logging is not enabled on this receiver.</Empty>
            )}

            {!state.off && state.error && (
                <div className="note note--warn">{`Beacon spots unavailable: ${state.error}`}</div>
            )}

            {!state.off && !state.error && !state.loading && rows.length === 0 && (
                <Empty>{emptyNote}</Empty>
            )}

            {page.length > 0 && (
                <div className="list ncdxf-list">
                    {page.map((row) => (
                        <Row
                            key={row.call}
                            row={row}
                            beacon={byCall.get(row.call)}
                            rx={rx}
                            selected={band}
                            now={now}
                            tunes={running}
                            onTune={tune}
                        />
                    ))}
                </div>
            )}

            {!minimal && (
                <ShowMore
                    shown={page.length}
                    total={rows.length}
                    base={PAGE}
                    count={false}
                    onMore={() => setShown((n) => n + PAGE)}
                    onLess={() => setShown(PAGE)}
                    label="Show more beacons"
                />
            )}

            {/* The numbers the list implies but does not state, and the ones the
                map cannot: what the average signal was, and which beacon came
                furthest. Withheld in a cut-down view along with everything else
                that is not a row. */}
            {!minimal && rows.length > 0 && (
                <div className="ncdxf-foot">
                    <span className="ncdxf-foot__stat">
                        {stats.avgSnr != null ? `avg ${snrLabel(stats.avgSnr)}` : ''}
                        {stats.far ? ` · best DX ${stats.far.call} ${stats.far.distKm.toLocaleString()} km` : ''}
                    </span>
                    {silent.length > 0 && (
                        <span className="ncdxf-foot__silent" title={silent.join(', ')}>
                            {`Not heard${heardOn}: ${silent.slice(0, 3).join(', ')}`}
                            {silent.length > 3 ? ` +${silent.length - 3}` : ''}
                        </span>
                    )}
                </div>
            )}

            {!minimal && (
                <div className="row-end">
                    <Button
                        size="sm"
                        variant="ghost"
                        icon={<Icon.Grid />}
                        disabled={rows.length === 0}
                        title={rows.length
                            ? 'The beacons on a world map, with the path to each one heard'
                            : 'Nothing heard to put on a map'}
                        onClick={() => setMapOpen(true)}
                    >
                        Map
                    </Button>
                    <a
                        className="btn btn--ghost btn--sm"
                        href={PAGE_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="The full beacon page: the live schedule, a day of history per band, and a replay"
                    >
                        Full page
                        <Icon.External size={13} />
                    </a>
                </div>
            )}

            {mapOpen && (
                <Modal onClose={() => setMapOpen(false)} label="NCDXF beacons on the map">
                    <div className="ncdxf-modal">
                        <div className="ncdxf-modal__head">
                            <span className="ncdxf-modal__title">NCDXF beacons</span>
                            <span className="ncdxf-modal__sub">
                                {`${rows.length} of ${BEACON_COUNT} heard${heardOn} in ${windowLabel(prefs.window)}`}
                            </span>
                            <BandPicker
                                value={prefs.band}
                                dialBand={dialBand}
                                onChange={(v) => set({ band: v })}
                            />
                        </div>
                        <BeaconMap
                            roster={state.roster}
                            rows={rows}
                            band={band}
                            receiver={serverInfo && serverInfo.receiver}
                            now={now}
                        />
                        {/* The dots are coloured by signal, on the same scale
                            as the pips in the panel, so the key names the scale
                            rather than repeating the colours. */}
                        <div className="ncdxf-modal__key">
                            Coloured by signal · grey beacons were not heard ·
                            {' each path is one that got through'}
                        </div>
                    </div>
                </Modal>
            )}
        </div>
    );
}
