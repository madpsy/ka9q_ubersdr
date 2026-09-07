// Announced DX operations — who is on the air from somewhere rare, and who is
// about to be.
//
// Worth a panel on a shared receiver rather than only in a logging program.
// Nobody works a DXpedition through a web SDR, so everything a logger's version
// of this exists for — needs, awards, one-click QSY into a pileup — is gone. What
// is left is the part a listener actually wants: something unusual is on the air
// right now, here is where it is and what it is using, go and listen to it.
//
// The panel is absent entirely on a receiver whose calendar is empty or whose
// feed cannot be reached — see lib/dxpeditions.js and the gate in registry.jsx.
// No empty slot explaining that there are no DXpeditions today.
//
// Two different "all"s, which is a real risk of confusion and is why they are
// worded and placed as differently as they are:
//
//   the Show all SWITCH   changes WHAT the calendar is — active operations only,
//                         or every announcement including the ones months out.
//                         Off by default: "on the air now" is the question a
//                         listener is asking, and the forward calendar is forty
//                         entries of things they cannot hear yet.
//   the Show all BUTTON   changes HOW MUCH of it is on screen — the whole of the
//                         current list in a modal, instead of a page of five in
//                         a dock column. It follows the switch rather than
//                         overriding it, so the button never shows rows the
//                         panel behind it has been told to leave out.
//
// `minimal` keeps the list and drops everything around it: the count and the
// Show all switch above it, the pager below it, and the Show All button under
// that. What is left is five operations on the air now, and nothing else.
//
// That is the whole of a cut-down view's job. Every control removed here can
// still be reached — minimal is a per-panel setting, and turning it off puts all
// four back — so the question is not whether they are available but whether they
// earn a line in a panel that has been asked to be small. Three rows of chrome
// around five rows of content does not.

import React, { useEffect, useMemo, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Button, Empty, Icon, Modal, ShowMore, Switch } from '../components/ui.jsx';
import CallsignMap from '../components/CallsignMap.jsx';
import SpotsWorldMap from '../components/SpotsWorldMap.jsx';
import { countryFlag } from '../lib/format.js';
import { lookupCallsign } from '../compat/legacyBridge.js';
import { requestLookup } from '../lib/callsign.js';
import {
    bandLabel, bearingLabel, datesLabel, dxpedKey, dxpeditionState, isActive,
    listenFor, onDXpeditions, placedBy, pollDXpeditions, positionOf, runLabel,
    visibleDXpeditions, websiteOf,
} from '../lib/dxpeditions.js';

// Rows before the first press of Show more, and how many each press adds. Five
// because a left-dock column is narrow and these rows are two lines each — the
// same reasoning as the spot and listener lists, which land in the same dock.
const PAGE = 5;

const ALL_KEY = 'ubersdr.v2.dxpeditions.all';

function savedAll() {
    try {
        return localStorage.getItem(ALL_KEY) === 'on';
    } catch (e) {
        return false;
    }
}

function saveAll(on) {
    try { localStorage.setItem(ALL_KEY, on ? 'on' : 'off'); } catch (e) { /* private mode */ }
}

// A minute is as fine as this needs: every date in the feed is a whole day, so
// the only thing a clock changes here is a row crossing into or out of its run.
const TICK_MS = 60_000;

/**
 * One row: who and where on the first line, when and on what on the second.
 *
 * A button rather than a div because the whole row opens the detail — there is
 * nothing else on it to press, and a row-sized target is what a phone needs.
 */
function Row({ entry, now, onOpen }) {
    const flag = countryFlag(entry.country_code);
    const where = [flag, entry.entity].filter(Boolean).join(' ');
    const live = isActive(entry, now);

    const detail = [
        bandLabel(entry.bands),
        (entry.modes || []).join(' '),
    ].filter(Boolean).join('  ·  ');
    const listen = listenFor(entry);

    const title = [
        entry.announced_as
            // The announcement's callsign field said only the country's prefix;
            // `call` is what it went on to say a line later.
            ? `${entry.call} — announced as ${entry.announced_as}`
            : `${entry.call}${listen.known ? '' : ' — a prefix; no callsign announced yet'}`,
        entry.country || entry.entity,
        datesLabel(entry),
        entry.bands && entry.bands.length ? `Bands: ${entry.bands.join(' ')}` : '',
        entry.modes && entry.modes.length ? `Modes: ${entry.modes.join(' ')}` : '',
        bearingLabel(entry),
        'Click for details and a map',
    ].filter(Boolean).join('\n');

    return (
        <button
            type="button"
            className={`list__row dxp-row${live ? ' is-active' : ''}`}
            title={title}
            onClick={() => onOpen(entry)}
        >
            {/* Two lines, each its own flex row rather than two rows of one
                grid. A grid cannot give its rows different column widths, so
                the bands-and-modes line below used to set the width of the
                callsign column above it — and an operation announcing most of
                HF pushed the country off the end of a line it is not even on. */}
            <span className="dxp-row__line">
                <span className="dxp-row__call">
                    {listen.call}
                    {/* Several operators, several calls. The rest are in the
                        detail; the row says there are more rather than growing
                        a second line for them. */}
                    {listen.more > 0 && <em className="dxp-row__pfx">{`+${listen.more}`}</em>}
                    {/* Marked ONLY when nothing can be listened for. A third of
                        the feed is announced before its callsign is issued, but
                        most of those announcements say what the call will be a
                        line later — and a row headed by a recovered call has no
                        business also calling itself a prefix. Two entries in the
                        feed genuinely have not said, and this is for them. */}
                    {!listen.known && <em className="dxp-row__pfx">prefix</em>}
                </span>
                <span className="dxp-row__where">{where}</span>
            </span>
            <span className="dxp-row__line">
                <span className="dxp-row__detail">{detail}</span>
                <span className="dxp-row__when">{runLabel(entry, now)}</span>
            </span>
        </button>
    );
}

/** A labelled line in the detail modal. Absent rather than blank when unknown. */
function Fact({ label, children }) {
    if (children == null || children === '' || children === false) return null;
    return (
        <div className="dxp-fact">
            <span className="dxp-fact__label">{label}</span>
            <span className="dxp-fact__value">{children}</span>
        </div>
    );
}

/**
 * The operations as points for the world map.
 *
 * SpotsWorldMap speaks spots, so this is an adapter rather than a second map: it
 * already draws a receiver pin, a great circle on hover, hover tooltips and a
 * throttled marker layer, and none of that is worth writing twice for a list
 * that is the same shape.
 *
 * Two differences from a spot worth noting. Its own `placeable` derives a
 * position from a Maidenhead locator, which is no use here — an operation is
 * placed server-side from a locator, an entity centroid or a callsign prefix,
 * and only a tenth of them carry a grid at all — so the coordinates go in
 * directly. And `mode` carries the bands as well as the modes, because for a
 * DXpedition "where do I listen" is the bands: the field is what a station is
 * using, and that is both halves of it.
 *
 * An operation nothing could place is dropped, and the caller says how many —
 * quietly showing a partial map as though it were the whole one is the failure
 * SpotsWorldMap's own count exists to avoid.
 */
function mapPoints(rows) {
    const out = [];
    for (const e of rows) {
        const at = positionOf(e);
        if (!at) continue;
        out.push({
            lat: at.lat,
            lon: at.lon,
            spot: {
                key: dxpedKey(e),
                // What will be on the air, not the country prefix the
                // announcement had to use before the licence came through.
                callsign: listenFor(e).call,
                mode: [bandLabel(e.bands, 6), (e.modes || []).join(' ')].filter(Boolean).join('  ·  '),
                grid: e.grid || '',
                country: e.country || e.entity,
                distanceKm: e.distance_km,
                // Carried through so a picked point can become the single view
                // without looking the operation up again.
                entry: e,
            },
        });
    }
    return out;
}

/**
 * One operation in full, with the map — and a swap to the map of all of them.
 *
 * The single view's map is `CallsignMap` unchanged, the same component the
 * Callsign panel and the spot modal draw, given the operation's position and
 * this receiver's so it draws both pins and the great-circle path between them.
 * That path is the whole reason the modal has a map: the numbers say 8,343 km on
 * 164°, and the picture says which way to point an antenna and what the signal
 * has to cross.
 *
 * The all view is the same question asked of the whole list — where is
 * everything, and what does that say about where to listen. `rows` is the list
 * the PANEL is showing, already filtered by its Show all switch, so this button
 * changes how much of the map you see and never what the list is. The two
 * controls stay the same two they are in the panel.
 */
function Detail({ entry, rows, receiver, now, onClose, onLookup }) {
    // Opens on the operation that was clicked: somebody who pressed a row asked
    // about that row, and the wider map is one press away. Same rule as SpotMap.
    //
    // Initial state and no effect syncing it to `entry`, because the caller
    // gives this a key of the operation: a different one is a different modal
    // and remounts, which is the invariant stated structurally rather than
    // re-established afterwards by an effect that has to be got right.
    const [shown, setShown] = useState(entry);
    const [view, setView] = useState('one');

    const many = view === 'all';
    const points = useMemo(() => (many ? mapPoints(rows) : []), [many, rows]);

    const position = positionOf(shown);
    const site = websiteOf(shown);
    const flag = countryFlag(shown.country_code);
    const listen = listenFor(shown);

    // Where the receiver is, when it has said. 0,0 is the config default rather
    // than a position — the same test the spot map makes — and a path drawn from
    // the Gulf of Guinea is worse than no path at all.
    const rx = receiver && receiver.gps && (receiver.gps.lat || receiver.gps.lon)
        ? { lat: receiver.gps.lat, lon: receiver.gps.lon, label: receiver.callsign || 'Receiver' }
        : null;

    return (
        <Modal
            onClose={onClose}
            label={many ? 'Announced DX operations on the map' : `${listen.call} — announced DX operation`}
        >
            <div className={`dxp-detail${many ? ' dxp-detail--wide' : ''}`}>
                <div className="dxp-detail__head">
                    <span className="dxp-detail__call">{many ? 'All on the map' : listen.call}</span>
                    <span className="dxp-detail__entity">
                        {many
                            ? `${points.length} of ${rows.length} placed`
                            : [flag, shown.country || shown.entity].filter(Boolean).join(' ')}
                    </span>
                    {!many && (
                        <span className={`dxp-detail__state${isActive(shown, now) ? ' is-live' : ''}`}>
                            {isActive(shown, now) ? 'On the air' : runLabel(shown, now)}
                        </span>
                    )}
                    {/* The two views, one button, each naming the other — which
                        is what a toggle is for. It sits in the title row because
                        it changes what the whole modal is about rather than what
                        is in it, and it shows the same set the panel behind it
                        is showing: on the air now, or every announcement,
                        following the panel's own switch. */}
                    <Button
                        size="sm"
                        variant="ghost"
                        className="dxp-detail__swap"
                        icon={many ? <Icon.Target /> : <Icon.Grid />}
                        title={many
                            ? `Back to ${listen.call} on its own`
                            : 'Put every operation this panel is showing on one map'}
                        onClick={() => setView(many ? 'one' : 'all')}
                    >
                        {many ? listen.call : 'Show all'}
                    </Button>
                </div>

                {many && (
                    <SpotsWorldMap
                        points={points}
                        receiver={receiver}
                        className="csmap--modal csmap--world"
                        // Every call written under its dot, rather than one at a
                        // time under the pointer. This map is a calendar of
                        // announced operations — a few dozen at the outside, and
                        // the question asked of it is "who is where", which a
                        // map you have to interrogate station by station answers
                        // slowly. The spot map does not take this and must not:
                        // it draws up to 1200 decodes, where the same labels are
                        // a wall of text with a map somewhere behind it.
                        labels
                        // Picking one is asking about that operation, which is
                        // the other view's whole job — so it switches, rather
                        // than growing a second way to say the same thing.
                        onPick={(sp) => {
                            setShown(sp.entry);
                            setView('one');
                            if (onLookup) onLookup(sp.entry);
                        }}
                    />
                )}

                {many && points.length === 0 && (
                    <Empty>
                        {rows.length
                            ? 'None of these operations could be placed.'
                            : 'Nothing to put on the map.'}
                    </Empty>
                )}

                {!many && position && (
                    <CallsignMap
                        call={listen.call}
                        position={position}
                        lines={[shown.country || shown.entity, datesLabel(shown)].filter(Boolean)}
                        className="csmap--modal"
                        from={rx}
                        zoomable
                    />
                )}

                {!many && !position && <Empty>No position for {listen.call}.</Empty>}

                {/* The caveat, and it is not decoration: two of the three ways an
                    operation gets placed are a country's centre, and a map is
                    very good at making a centroid look like an address. */}
                {!many && position && placedBy(shown) && (
                    <div className="dxp-detail__caveat">Placed {placedBy(shown)}.</div>
                )}

                {/* One operation's facts belong under one operation. In the all
                    view the map is the answer, and a fact table under it would
                    be describing whichever row happened to be picked last. */}
                {!many && (
                    <div className="dxp-facts">
                        <Fact label="Dates">{datesLabel(shown)}</Fact>
                        <Fact label="Bands">{(shown.bands || []).join(' ')}</Fact>
                        <Fact label="Modes">{(shown.modes || []).join(' ')}</Fact>
                        <Fact label="Beam">{bearingLabel(shown)}</Fact>
                        <Fact label="Grid">{shown.grid}</Fact>
                        <Fact label="IOTA">{shown.iota}</Fact>
                        {/* The prefix the source announced it under, when the
                            callsign above was recovered from the text — so the
                            row can still be matched against where it came from. */}
                        <Fact label="Announced as">{shown.announced_as}</Fact>
                        {/* The other operators going, when there are any. */}
                        <Fact label="Also on">
                            {(shown.operating_calls || []).slice(1).join(' ')}
                        </Fact>
                        <Fact label="Also as">{(shown.also_calls || []).join(' ')}</Fact>
                        <Fact label="QSL">{shown.qsl}</Fact>
                        <Fact label="Announced by">{shown.source}</Fact>
                        {/* Only worth saying when it is false, and then it is
                            worth saying loudly: every band this operation
                            announced is outside what this receiver can tune. */}
                        <Fact label="Coverage">
                            {shown.in_range ? null : 'None of the announced bands are in this receiver’s range'}
                        </Fact>
                        {/* Only when nothing could be recovered. Most
                            prefix-only announcements say what the call will be
                            further down their own text; this is the handful
                            that genuinely have not. */}
                        {!listen.known && (
                            <Fact label="Callsign">
                                {`${shown.call} is the entity's prefix — the announcement does not say what callsign will be used`}
                            </Fact>
                        )}
                    </div>
                )}

                {/* The announcement in the words it was written in. The bands and
                    modes above are a best-effort parse of exactly this line, and
                    when the parse misses something ("80-10m, perhaps 160m" keeps
                    the range and drops the maybe) this is where it is still
                    readable. */}
                {!many && shown.info && <div className="dxp-detail__info">{shown.info}</div>}

                {!many && site && (
                    <a
                        className="btn btn--ghost btn--sm dxp-detail__link"
                        href={site}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        The operation&rsquo;s own page
                        <Icon.External size={13} />
                    </a>
                )}
            </div>
        </Modal>
    );
}

/** Every row of the current list at once, for a screen that has room for them. */
function AllModal({ rows, now, all, onOpen, onClose }) {
    return (
        <Modal onClose={onClose} label="Announced DX operations">
            <div className="dxp-all">
                <div className="dxp-all__head">
                    <span className="dxp-all__title">
                        {all ? 'Every announced operation' : 'On the air now'}
                    </span>
                    <span className="dxp-all__count">{rows.length}</span>
                </div>
                {rows.length === 0
                    ? <Empty>Nothing to show.</Empty>
                    : (
                        <div className="list dxp-list dxp-list--all">
                            {rows.map((e) => (
                                <Row key={dxpedKey(e)} entry={e} now={now} onOpen={onOpen} />
                            ))}
                        </div>
                    )}
            </div>
        </Modal>
    );
}

export default function DXpeditionsPanel({ minimal }) {
    const { serverInfo } = useRadio();
    const [state, setState] = useState(dxpeditionState);
    const [all, setAll] = useState(savedAll);
    const [shown, setShown] = useState(PAGE);
    const [picked, setPicked] = useState(null);
    const [allOpen, setAllOpen] = useState(false);
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => onDXpeditions(setState), []);
    useEffect(() => pollDXpeditions(), []);

    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), TICK_MS);
        return () => clearInterval(id);
    }, []);

    const entries = state.entries;
    const rows = useMemo(
        () => visibleDXpeditions(entries, { all, now }),
        [entries, all, now],
    );

    // Minimal is the first page with no way to grow it, so a list left expanded
    // does not stay expanded when the panel is cut down.
    const page = rows.slice(0, minimal ? PAGE : shown);

    // Whether this receiver can look a callsign up at all. Same gate the spot
    // rows, the voice panels and the marker bar use.
    const lookups = !!(serverInfo && serverInfo.lookup_service);

    /**
     * Opening one operation, which is also asking who it is.
     *
     * Paired the way the spot rows pair tuning with a lookup: the in-app
     * Callsign panel wins when it is open, and otherwise the v1 popup gets it if
     * THAT is open. Neither is ever opened by this click — requestLookup only
     * talks to a listening panel and lookupCallsign only talks to a window that
     * already exists, because a click that spawns a window nobody asked for is
     * what popup blockers are for.
     *
     * Skipped for a prefix-only entry, and that is the whole payoff of the flag
     * meaning what it now means: there is no callsign to look up, and asking
     * about "HK0" would return whatever the lookup service makes of a country
     * prefix. Everything else — including the two thirds of prefix announcements
     * whose callsign was recovered from the text — has a real call to ask about.
     */
    const lookUp = (e) => {
        if (!lookups || !e || e.prefix_only || !e.call) return;
        if (!requestLookup(e.call)) lookupCallsign(e.call);
    };

    const openDetail = (e) => {
        setPicked(e);
        lookUp(e);
    };

    const toggleAll = (on) => {
        saveAll(on);
        setAll(on);
        // Back to the first page: the list just became a different list, and a
        // window six presses down it says nothing about the new one.
        setShown(PAGE);
    };

    return (
        <div className="stack">
            {/* The count and the switch. Both go in a cut-down view: the count
                is a fact about a list you can see, and the switch changes what
                the panel is about, which is a decision taken once and not one
                worth a row of a small panel. */}
            {!minimal && (
                <div className="dxp-head">
                    <span className="dxp-head__count">
                        {state.loading
                            ? 'Loading…'
                            : `${rows.length} ${all ? 'announced' : 'on the air'}`}
                    </span>
                    <Switch
                        checked={all}
                        onChange={toggleAll}
                        label="Show all"
                        title={all
                            ? 'Showing every announcement, including operations that have not started — click for the ones on the air now'
                            : 'Showing only operations on the air now — click for the whole forward calendar'}
                    />
                </div>
            )}

            {rows.length === 0 && !state.loading && (
                <Empty>
                    {all
                        ? 'No announced operations.'
                        : 'No DXpeditions are on the air right now.'}
                </Empty>
            )}

            {page.length > 0 && (
                <div className="list dxp-list">
                    {page.map((e) => (
                        <Row key={dxpedKey(e)} entry={e} now={now} onOpen={openDetail} />
                    ))}
                </div>
            )}

            {/* The pager. Growing the list in place is exactly what a cut-down
                view is avoiding. */}
            {!minimal && (
                <ShowMore
                    shown={page.length}
                    total={rows.length}
                    base={PAGE}
                    count={false}
                    onMore={() => setShown((n) => n + PAGE)}
                    onLess={() => setShown(PAGE)}
                    label="Show more operations"
                />
            )}

            {/* Offered whenever there is anything to open. Not gated on the list
                being longer than a page: even when the dock is already showing
                every row, the modal is the room the dock column does not have —
                wider rows, no paging, and nothing else on screen. Withheld in
                two cases: an empty list, where it could only ever open an empty
                dialog, and a cut-down view, where it is the last of the three
                rows of chrome that minimal exists to take away. */}
            {!minimal && rows.length > 0 && (
                <div className="row-end">
                    <Button
                        size="sm"
                        variant="ghost"
                        icon={<Icon.List />}
                        title={all
                            ? 'Every announced operation, in one list'
                            : 'Every operation on the air now, in one list'}
                        onClick={() => setAllOpen(true)}
                    >
                        Show All
                    </Button>
                </div>
            )}

            {picked && (
                <Detail
                    // A different operation is a different modal: the key
                    // remounts it, so its view and the operation it is showing
                    // start fresh rather than being reset by an effect.
                    key={dxpedKey(picked)}
                    entry={picked}
                    // The list the PANEL is showing, already filtered by its
                    // Show all switch — so the modal's own toggle changes how
                    // much of the map you see and never what the list is.
                    rows={rows}
                    // `receiver` is the station identity block, not the whole
                    // description: /api/description puts name, callsign and gps
                    // under `receiver`, and the top level carries the tuning
                    // range and the feature flags. Passing the wrong one reads
                    // `gps` off an object that has never had it, so the pin and
                    // the path silently do not draw. Same argument the spot map
                    // is given.
                    receiver={serverInfo && serverInfo.receiver}
                    now={now}
                    onClose={() => setPicked(null)}
                    onLookup={lookUp}
                />
            )}

            {allOpen && (
                <AllModal
                    rows={rows}
                    now={now}
                    all={all}
                    // Opening one from the big list replaces it rather than
                    // stacking a second modal on top: two dismissable layers is
                    // two Escapes to get back to the panel.
                    onOpen={(e) => { setAllOpen(false); openDetail(e); }}
                    onClose={() => setAllOpen(false)}
                />
            )}
        </div>
    );
}
