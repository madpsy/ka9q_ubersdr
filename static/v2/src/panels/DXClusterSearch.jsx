// The DX cluster panel's spot search, as a modal.
//
// Opened from the magnifier beside Send. What it answers is the question the
// terminal answers badly: where has this callsign been heard, and on what. In
// the transcript that is `sh/dx G3ABC` — a command whose reply is however much
// of the cluster's own short buffer it still has, printed as text you read by
// eye. Here it is the addon's database, which keeps a month of every stream it
// runs, and the reply is rows.
//
// Rows are the point. A row arrives with a frequency and a mode in it, so
// clicking one tunes the receiver — which is the thing the addon's own search
// tab, sitting in a browser tab that has never heard of this radio, cannot do.
//
// See lib/dxclusterSearch.js for the API, the four controls this keeps of the
// addon's twenty-five, why the third one filters the stream rather than the
// mode, and why a digital row is tuneable here when the same spot in the
// transcript is not.

import React, { useCallback, useEffect, useRef, useState } from '../react.js';
import { Button, Empty, Icon, Modal, ShowMore } from '../components/ui.jsx';
import { countryFlag, freqInRange } from '../lib/format.js';
import { MAX_CALLSIGN } from '../lib/dxclusterTerminal.js';
import {
    DEFAULT_PERIOD, PERIODS, bandsFrom, dayLabel, fetchSearch,
    fetchSearchMeta, khzLabel, modeLabel, receiverMode, resultSummary,
    snrLabel, sourcesFrom, spotKey, spotNote, tuneFreq, utcLabel,
} from '../lib/dxclusterSearch.js';

// The meta document is the band ladder and the mode groups, and neither changes
// while a page is open. Cached at module scope rather than in the component so
// that closing and reopening the modal — which is what you do between two
// searches — does not refetch it each time.
let metaCache = null;
let metaInFlight = null;

// How long after the last keystroke the query goes out. A search costs the
// server a real read, and a callsign typed at speed would otherwise send one per
// letter; a quarter of a second is below the point where the list feels like it
// is waiting for you.
const TYPE_DELAY_MS = 250;

/** One result. A button, because the whole row tunes the receiver. */
function Row({ spot, onTune }) {
    const hz = tuneFreq(spot);
    const tuneable = freqInRange(hz);
    const mode = modeLabel(spot);
    const flag = countryFlag(spot.country_code);
    const note = spotNote(spot);
    const snr = snrLabel(spot);

    const body = (
        <>
            <span className="dxs-row__when">
                <span className="dxs-row__utc">{utcLabel(spot.timestamp)}</span>
                <span className="dxs-row__day">{dayLabel(spot.timestamp)}</span>
            </span>
            <span className="dxs-row__call">{spot.callsign}</span>
            <span className="dxs-row__freq">{khzLabel(hz)}</span>
            <span className="dxs-row__band">{spot.band}</span>
            {mode && <span className="dxs-row__mode">{mode}</span>}
            {snr && <span className="dxs-row__snr">{snr}</span>}
            <span className="dxs-row__where">
                {flag && <span className="dxs-row__flag">{flag}</span>}
                {spot.country || ''}
            </span>
            {note && <span className="dxs-row__note">{note}</span>}
        </>
    );

    // Out of this receiver's range, so there is nowhere to send you. Shown all
    // the same — that a station was heard is the answer, and hiding the row
    // would make the count disagree with the list — but as text rather than as
    // a button that does nothing.
    if (!tuneable) {
        return <div className="dxs-row dxs-row--flat" title="Outside this receiver's tuning range">{body}</div>;
    }

    return (
        <button
            type="button"
            className="dxs-row"
            title={`Tune to ${spot.callsign} — ${khzLabel(hz)} kHz ${receiverMode(spot).toUpperCase()}`}
            onClick={() => onTune(spot)}
        >
            {body}
        </button>
    );
}

/** A row of multi-select chips: pressed ones are the filter, none pressed is all. */
function Chips({ label, options, chosen, onToggle, keyOf = (o) => o, labelOf = (o) => o }) {
    if (!options.length) return null;
    return (
        <div className="dxs-filter">
            <span className="dxs-filter__label">{label}</span>
            <div className="chip-row chip-row--wrap">
                {options.map((o) => {
                    const key = keyOf(o);
                    const on = chosen.includes(key);
                    return (
                        <button
                            key={key}
                            type="button"
                            className={`chip chip--button${on ? ' is-active' : ''}`}
                            aria-pressed={on}
                            onClick={() => onToggle(key)}
                        >
                            {labelOf(o)}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

export default function DXClusterSearch({ onClose, onTune }) {
    const [meta, setMeta] = useState(metaCache);
    const [call, setCall] = useState('');
    const [period, setPeriod] = useState(DEFAULT_PERIOD);
    const [bands, setBands] = useState([]);
    const [sources, setSources] = useState([]);

    const [rows, setRows] = useState([]);
    const [page, setPage] = useState({ total: null, capped: false, took: null, cursor: '', more: false });
    const [busy, setBusy] = useState(true);
    const [error, setError] = useState('');

    // The request in flight, so a new query can cancel the one it replaces —
    // otherwise two searches race and the slower one wins by arriving last.
    const abortRef = useRef(null);
    const liveRef = useRef(true);

    useEffect(() => () => {
        liveRef.current = false;
        if (abortRef.current) abortRef.current.abort();
    }, []);

    useEffect(() => {
        if (metaCache) return undefined;
        metaInFlight = metaInFlight || fetchSearchMeta();
        let live = true;
        metaInFlight.then((m) => {
            metaCache = m;
            if (live) setMeta(m);
        }).catch(() => {
            // The filters are what meta provides; without it the callsign box
            // and the period chips still work, which is the search anyway.
            metaInFlight = null;
        });
        return () => { live = false; };
    }, []);

    const bandList = bandsFrom(meta);
    const sourceList = sourcesFrom(meta);

    // The two chip selections as the strings that go into the query, because
    // those are what a new search actually depends on. Depending on `meta`
    // instead would re-run the search the moment the band ladder arrived — an
    // identical query, since no chip can have been pressed before there were
    // chips to press — and every modal opened would cost two reads instead of
    // one.
    const bandCsv = bands.join(',');
    const sourceCsv = sources.join(',');

    /**
     * Run one query. `cursor` appends the next page; without it this is a new
     * search and the list is replaced.
     */
    const run = useCallback((cursor) => {
        if (abortRef.current) abortRef.current.abort();
        const ac = new AbortController();
        abortRef.current = ac;
        setBusy(true);
        setError('');

        const params = {
            callsign: call,
            bands: bandCsv ? bandCsv.split(',') : [],
            streams: sourceCsv ? sourceCsv.split(',') : [],
            period,
            cursor,
        };

        fetchSearch(params, undefined, ac.signal).then((data) => {
            if (!liveRef.current || ac.signal.aborted) return;
            const spots = Array.isArray(data.spots) ? data.spots : [];
            setRows((prev) => (cursor ? prev.concat(spots) : spots));
            setPage({
                total: data.total == null ? null : Number(data.total),
                capped: !!data.total_capped,
                took: data.took_ms == null ? null : Number(data.took_ms),
                cursor: data.next_cursor || '',
                more: !!data.has_more,
            });
            setBusy(false);
        }).catch((e) => {
            // An abort is this component replacing its own query, not a failure.
            if (!liveRef.current || ac.signal.aborted || (e && e.name === 'AbortError')) return;
            setError(e && e.message ? e.message : 'search failed');
            setBusy(false);
        });
    }, [call, bandCsv, sourceCsv, period]);

    // Every filter change is a new search, debounced so that typing a callsign
    // sends one query rather than one per letter. It runs on open too, with
    // nothing filled in: a modal that opens showing the last day of spots says
    // what it is far better than an empty box does.
    useEffect(() => {
        const t = setTimeout(() => run(), TYPE_DELAY_MS);
        return () => clearTimeout(t);
    }, [run]);

    const toggle = (setter) => (key) => setter((prev) => (
        prev.includes(key) ? prev.filter((k) => k !== key) : prev.concat(key)
    ));

    const tune = (spot) => {
        onTune(spot);
        onClose();
    };

    const total = page.total == null ? rows.length : page.total;

    return (
        <Modal onClose={onClose} label="Search the DX cluster spot archive">
            <div className="dxs">
                <div className="dxs__head">
                    <Icon.Search size={15} />
                    <span className="dxs__title">Search spots</span>
                </div>

                <div className="dxs__form">
                    <div className="dxs-filter">
                        <span className="dxs-filter__label">Callsign</span>
                        <input
                            className="input dxs__call"
                            placeholder="G3ABC, or a prefix"
                            value={call}
                            maxLength={MAX_CALLSIGN}
                            autoFocus
                            autoComplete="off"
                            spellCheck={false}
                            onChange={(e) => setCall(e.target.value)}
                            // The window's shortcut watcher would otherwise read
                            // this as tuning keys, the same reason the command
                            // line stops its own Enter.
                            onKeyDown={(e) => e.stopPropagation()}
                        />
                        {call && (
                            <Button
                                size="sm"
                                variant="ghost"
                                icon={<Icon.Close size={14} />}
                                title="Clear the callsign"
                                onClick={() => setCall('')}
                            />
                        )}
                    </div>

                    <Chips
                        label="Period"
                        options={PERIODS}
                        chosen={[period]}
                        onToggle={setPeriod}
                        keyOf={(p) => p.key}
                        labelOf={(p) => p.label}
                    />
                    <Chips label="Band" options={bandList} chosen={bands} onToggle={toggle(setBands)} />
                    {/* Source, not mode. Digital, CW and Voice are the three
                        streams that record a mode and are the mode filter in
                        everything but name; DX cluster and Local spots are the
                        two that keep theirs in the comment, and a mode filter
                        could only ever exclude them. See sourcesFrom. */}
                    <Chips
                        label="Source"
                        options={sourceList}
                        chosen={sources}
                        onToggle={toggle(setSources)}
                        keyOf={(s) => s.key}
                        labelOf={(s) => s.label}
                    />
                </div>

                <div className="dxs__status">
                    {error
                        ? <span className="dxs__error">{error}</span>
                        : busy && !rows.length
                            ? <span>Searching…</span>
                            : <span>{resultSummary({
                                shown: rows.length, total: page.total,
                                capped: page.capped, took: page.took,
                            })}</span>}
                    {/* The one filter that is always on and is not a control.
                        Said out loud because a count that disagrees with the
                        addon's own search tab needs a reason. */}
                    <span className="dxs__note">anonymous voice detections excluded</span>
                </div>

                <div className="dxs__rows">
                    {rows.length ? rows.map((spot, i) => (
                        <Row key={spotKey(spot, i)} spot={spot} onTune={tune} />
                    )) : !busy && !error && (
                        <Empty>No spots match these filters. Try a wider period.</Empty>
                    )}
                </div>

                {page.more && (
                    <ShowMore
                        shown={rows.length}
                        total={Math.max(total, rows.length + 1)}
                        onMore={() => run(page.cursor)}
                        label={busy ? 'Loading…' : 'Show more'}
                    />
                )}

            </div>
        </Modal>
    );
}
