// FT8 decoder — v1's extension, rebuilt for v2.
//
// The decoding happens on the server: this attaches the `ft8` audio extension
// to the session's audio (see ../useAudioExtension.js), and every decode comes
// back as one JSON frame. So there is no DSP here — the work is showing a
// fifteen-second cycle's worth of decodes in a way you can read while the next
// one is arriving.
//
// Behaviour is v1's, deliberately: the same controls with the same defaults,
// the same columns in the same order, newest first, the same 3 kHz spectrum
// with the previous same-parity slot's callsigns over it, and the same CSV
// export. What changed is that state is state rather than DOM — v1 sorts by
// re-appending table rows and filters by setting `display: none` on each, which
// is why it needs a debounce to stay ahead of a busy slot.
//
// Two clocks run here and are kept apart, as everywhere else in v2: decodes
// arrive on the server's slot boundary and go into React state, while the cycle
// progress bar ticks ten times a second inside its own component so it never
// re-renders the table.

import React, { useEffect, useMemo, useRef, useState } from '../../react.js';
import { useRadio } from '../../radio/RadioContext.jsx';
import { Button, Empty, Icon, ShowMore, Switch } from '../../components/ui.jsx';
import { countryFlag } from '../../lib/format.js';
import { subscribeAudioSpectrum } from '../../lib/audioSpectrum.js';
import { openCallsignLookup } from '../../compat/legacyBridge.js';
import { normaliseCallsign, requestLookup } from '../../lib/callsign.js';
import { getSessionId } from '../../radio/session.js';
import { useAudioExtension } from '../useAudioExtension.js';
import {
    AUTO_CLEAR_KEEP, COLUMNS, CYCLE_SEC, FT8_BANDWIDTH, FT8_FREQUENCIES, FT8_MODE,
    addMessage, cycleProgress, filterMessages, normaliseMessage, sortMessages, statsFrom, toCSV,
} from './messages.js';
import { drawSpectrum, labelsFor } from './spectrum.js';

// Rows rendered before "show more". A slot on a busy band is 30-50 decodes, so
// a page shows one cycle of 20 m without a press.
const PAGE = 60;

// The decoder's own settings, sent with the attach. `min_score` is fixed
// server-side and `protocol` is always FT8, so the only real knob is how many
// candidates a slot may try — left at v1's default rather than exposed, because
// raising it costs CPU on a machine shared with every other listener.
const PARAMS = { protocol: 'FT8', min_score: 10, max_candidates: 100 };

const SPECTRUM_H = 120;

const EMPTY_STATS = { total: 0, slotCount: 0, candidates: null, ldpc: null, crc: null, currentSlot: 0, lastAt: 0 };

// Whether a rule goes above row `i`, marking where one cycle's decodes end and
// the next begin. Only in arrival order: under a sort the rows are interleaved
// by whatever was sorted on, so a slot boundary is not a place on the table and
// a rule there would be drawing a line through nothing.
function slotBreakBefore(rows, i, sortColumn) {
    return !sortColumn && i > 0 && rows[i - 1].slot !== rows[i].slot;
}

function snrClass(snr) {
    if (snr >= 0) return 'ft8__snr ft8__snr--high';
    if (snr >= -10) return 'ft8__snr ft8__snr--mid';
    return 'ft8__snr ft8__snr--low';
}

// The cycle position, in its own component so its 100 ms tick cannot re-render
// the table. FT8 slots start on the minute and every 15 s after it.
function CycleProgress() {
    const [at, setAt] = useState(() => cycleProgress(Date.now()));
    useEffect(() => {
        const id = setInterval(() => setAt(cycleProgress(Date.now())), 100);
        return () => clearInterval(id);
    }, []);
    return (
        <div className="ft8__cycle" title={`FT8 cycle position (${CYCLE_SEC} s)`}>
            <div className="ft8__cycle-bar" style={{ width: `${at.fraction * 100}%` }} />
            <span className="ft8__cycle-text">{at.seconds.toFixed(1)}s</span>
        </div>
    );
}

// The 0-3 kHz audio spectrum with the previous same-parity slot's callsigns
// over it. Subscribes to the analyser directly and paints the canvas, so no
// frame of it ever reaches React.
function SpectrumStrip({ labels }) {
    const { player } = useRadio();
    const canvas = useRef(null);
    const labelsRef = useRef(labels);
    labelsRef.current = labels;

    useEffect(() => subscribeAudioSpectrum(player, { fftSize: 2048, bins: true }, (f) => {
        drawSpectrum(canvas.current, {
            bins: f.bins,
            binCount: f.binCount,
            sampleRate: f.sampleRate,
            labels: labelsRef.current,
            cssHeight: SPECTRUM_H,
        });
    }), [player]);

    return (
        <div
            className="ft8__spectrum"
            style={{ height: SPECTRUM_H }}
            title="Audio spectrum, 0–3 kHz. Labels are the callsigns decoded in the last cycle that transmitted on this alternation, at the tone each used"
        >
            <canvas ref={canvas} className="ft8__spectrum-canvas" />
        </div>
    );
}

export default function FT8Extension() {
    const { running, audioState, tuning, actions, serverInfo } = useRadio();
    // Attaching needs the audio session, not merely the power switch: the
    // server finds the session by the UUID this browser's audio socket opened
    // with, so between pressing Listen and that socket being up there is
    // nothing to attach to. Using this as the gate also restarts the decoder by
    // itself after an audio reconnect, which replaces the session server-side.
    const live = running && audioState === 'open';

    const [decoding, setDecoding] = useState(false);
    const [messages, setMessages] = useState([]);
    const [stats, setStats] = useState(EMPTY_STATS);
    // The spectrum starts off, unlike v1. It is a diagnostic — "is there
    // anything in the passband?" — not something you read while working the
    // decodes, and it costs the window 120 px and an FFT read per frame that
    // nothing pays for until it is switched on.
    const [opts, setOpts] = useState({
        cqOnly: false,
        autoClear: false,
        autoScroll: true,
        latestOnly: true,
        showSpectrum: false,
    });
    const [filterText, setFilterText] = useState('');
    const [sort, setSort] = useState({ column: null, dir: 'asc' });
    const [shown, setShown] = useState(PAGE);

    // The server sends no id with a decode, so the row key is a counter.
    const seq = useRef(0);
    const listRef = useRef(null);

    const onResult = (raw) => {
        const msg = normaliseMessage(raw, seq.current++);
        const s = statsFrom(raw);

        setMessages((prev) => {
            // A slot rolled when the newest decode we hold is from another one.
            const rolled = prev.length > 0 && prev[0].slot !== msg.slot;
            const base = rolled && opts.autoClear ? prev.slice(0, AUTO_CLEAR_KEEP) : prev;
            return addMessage(base, msg);
        });

        setStats((prev) => ({
            total: prev.total + 1,
            slotCount: msg.slot === prev.currentSlot ? prev.slotCount + 1 : 1,
            // Per-slot counters ride along on each decode; keep the last known
            // value when a decode omits them rather than blanking the readout.
            candidates: s.candidates ?? prev.candidates,
            ldpc: s.ldpcFailures ?? prev.ldpc,
            crc: s.crcFailures ?? prev.crc,
            currentSlot: msg.slot,
            lastAt: Date.now(),
        }));
    };

    const { state, error } = useAudioExtension({
        name: 'ft8',
        params: PARAMS,
        active: decoding && live,
        onResult,
    });

    // Powering the receiver off takes the audio session with it, so there is
    // nothing left to decode from — stop rather than leave a Stop button that
    // stops nothing. An audio *reconnect* is not that: it drops `live` for a
    // few seconds and the hook re-attaches on its own, so decoding stays on.
    useEffect(() => { if (!running && decoding) setDecoding(false); }, [running, decoding]);

    // A filter or sort change should show the top of the new list.
    useEffect(() => { setShown(PAGE); }, [opts.cqOnly, opts.latestOnly, filterText, sort]);

    const rows = useMemo(() => {
        const matched = filterMessages(messages, {
            cqOnly: opts.cqOnly,
            latestOnly: opts.latestOnly,
            text: filterText,
            currentSlot: stats.currentSlot,
        });
        return sortMessages(matched, sort.column, sort.dir);
    }, [messages, opts.cqOnly, opts.latestOnly, filterText, stats.currentSlot, sort]);

    const labels = useMemo(
        () => (opts.showSpectrum ? labelsFor(messages, stats.currentSlot) : []),
        [opts.showSpectrum, messages, stats.currentSlot],
    );

    // Newest is at the top, so "auto-scroll" means keeping the top in view —
    // and only when the rows are in arrival order, since a sorted table's new
    // row can land anywhere.
    useEffect(() => {
        if (!opts.autoScroll || sort.column || !listRef.current) return;
        listRef.current.scrollTop = 0;
    }, [messages, opts.autoScroll, sort.column]);

    const set = (patch) => setOpts((prev) => ({ ...prev, ...patch }));

    const tuneTo = (hz) => {
        actions.tuneTo({
            frequency: hz,
            mode: FT8_MODE,
            bandwidthLow: FT8_BANDWIDTH.low,
            bandwidthHigh: FT8_BANDWIDTH.high,
        });
        actions.ensureVisible(hz);
    };

    const clear = () => {
        setMessages([]);
        setStats((prev) => ({ ...EMPTY_STATS, currentSlot: prev.currentSlot }));
    };

    const start = () => {
        if (opts.autoClear) clear();
        setDecoding(true);
    };

    const exportCSV = () => {
        const blob = new Blob([toCSV(messages)], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ft8_log_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    // The in-app panel wins when it is open; otherwise the v1 popup, which is
    // allowed here because this is a click the user made.
    const lookup = (call) => {
        if (!call) return;
        if (requestLookup(call)) return;
        if (serverInfo && serverInfo.lookup_service) {
            openCallsignLookup({ uuid: getSessionId(), callsign: call });
        } else {
            // QRZ has no page for a compound call, so ask for the base one —
            // the same reduction the lookup popup does.
            window.open(`https://www.qrz.com/db/${encodeURIComponent(normaliseCallsign(call) || call)}`, '_blank', 'noopener');
        }
    };

    const sortBy = (id) => setSort((prev) => (
        prev.column === id
            ? { column: id, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
            : { column: id, dir: 'asc' }
    ));

    const statusLabel = !decoding
        ? 'Stopped'
        : (state === 'running' ? 'Running' : (state === 'error' ? 'Error' : 'Starting…'));
    const statusTone = !decoding ? 'off' : (state === 'running' ? 'on' : (state === 'error' ? 'bad' : 'wait'));

    const page = rows.slice(0, shown);

    return (
        <div className="ft8">
            <div className="ft8__bar">
                <span
                    className={`ft8__status ft8__status--${statusTone}`}
                    title="Whether the decoder is attached to your audio session on the server"
                >
                    {statusLabel}
                </span>
                <span className="ft8__bar-gap" />

                <select
                    className="select ft8__freq"
                    value=""
                    onChange={(e) => { if (e.target.value) tuneTo(Number(e.target.value)); }}
                    title="Tune to an FT8 frequency in USB with a 0-3200 Hz passband"
                >
                    <option value="">Tune to…</option>
                    {FT8_FREQUENCIES.map((g) => (
                        <optgroup key={g.group} label={g.group}>
                            {g.options.map((o) => <option key={o.hz} value={o.hz}>{o.label}</option>)}
                        </optgroup>
                    ))}
                </select>

                {decoding
                    ? (
                        <Button
                            size="sm"
                            onClick={() => setDecoding(false)}
                            icon={<Icon.Stop size={13} />}
                            title="Stop decoding and release the decoder on the server"
                        >
                            Stop
                        </Button>
                    )
                    : (
                        <Button
                            size="sm"
                            variant="primary"
                            onClick={start}
                            disabled={!live}
                            icon={<Icon.Power size={13} />}
                            title={live
                                ? 'Start decoding the audio this receiver is tuned to'
                                : 'Start the receiver first — the decoder runs on your audio session'}
                        >
                            Start
                        </Button>
                    )}
                <Button size="sm" variant="ghost" onClick={clear} disabled={!messages.length} icon={<Icon.Trash size={13} />} title="Clear every decode held" />
                <Button size="sm" variant="ghost" onClick={exportCSV} disabled={!messages.length} icon={<Icon.Download size={13} />} title="Download every decode held as CSV, oldest first" />
                {/* Beside the transport controls rather than down among the
                    filters: it says when the next decodes are due, which is
                    what you look at after pressing Start. */}
                <CycleProgress />
            </div>

            {!running && <div className="note note--tight">Start the receiver to decode.</div>}
            {running && !live && <div className="note note--tight">Waiting for the audio connection…</div>}
            {live && !decoding && <div className="note note--tight">Tune to an FT8 frequency in USB, then press Start.</div>}
            {/* The decoder takes whatever audio the session produces, so a wrong
                mode does not fail — it just never decodes anything. */}
            {decoding && tuning.mode !== FT8_MODE && (
                <div className="note note--warn">FT8 is USB; nothing will decode in {tuning.mode.toUpperCase()}.</div>
            )}
            {state === 'error' && <div className="note note--warn">{error}</div>}

            {/* Each switch says what it does on hover: two words of label is
                not enough to distinguish "latest cycle" (a view filter) from
                "auto-clear" (which actually discards decodes). */}
            <div className="ft8__controls">
                <Switch
                    label="CQ only"
                    title="Show only stations calling CQ, hiding replies, reports and 73s"
                    checked={opts.cqOnly}
                    onChange={(v) => set({ cqOnly: v })}
                />
                <Switch
                    label="Latest cycle"
                    title="Show only the cycle being decoded now. Off shows every decode still held — nothing is discarded either way"
                    checked={opts.latestOnly}
                    onChange={(v) => set({ latestOnly: v })}
                />
                <Switch
                    label="Auto-clear"
                    title={`Discard all but the newest ${AUTO_CLEAR_KEEP} decodes when a new cycle starts, and clear the list when you press Start`}
                    checked={opts.autoClear}
                    onChange={(v) => set({ autoClear: v })}
                />
                <Switch
                    label="Auto-scroll"
                    title="Keep the newest decode in view. Ignored while a column is sorted, since a new row can land anywhere"
                    checked={opts.autoScroll}
                    onChange={(v) => set({ autoScroll: v })}
                />
                <Switch
                    label="Spectrum"
                    title="Show the 0–3 kHz audio spectrum, labelled with the callsigns from the last cycle that transmitted on the same alternation"
                    checked={opts.showSpectrum}
                    onChange={(v) => set({ showSpectrum: v })}
                />
                <input
                    className="input ft8__filter"
                    type="text"
                    placeholder="Filter message or country…"
                    title="Show only decodes whose message or country contains this text"
                    value={filterText}
                    onChange={(e) => setFilterText(e.target.value)}
                />
            </div>

            {opts.showSpectrum && running && <SpectrumStrip labels={labels} />}

            <div className="ft8__table" ref={listRef}>
                <div className="ft8__row ft8__row--head">
                    {COLUMNS.map((c) => (
                        <button
                            key={c.id}
                            type="button"
                            className={`ft8__head ${c.cls}${sort.column === c.id ? ' is-sorted' : ''}`}
                            onClick={() => sortBy(c.id)}
                            title={`Sort by ${c.label}`}
                        >
                            {c.label}{sort.column === c.id ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                        </button>
                    ))}
                </div>

                {page.length === 0 && (
                    <Empty>
                        {messages.length === 0
                            ? (decoding ? 'Waiting for the next cycle…' : 'No decodes yet.')
                            : 'No decodes match these filters.'}
                    </Empty>
                )}

                {page.map((m, i) => (
                    <div
                        key={m.key}
                        className={`ft8__row${slotBreakBefore(page, i, sort.column) ? ' ft8__row--slot' : ''}`}
                        title={m.locator ? `${m.callsign} · ${m.locator}` : m.callsign}
                    >
                        <span className="ft8__c-time">{m.utc}</span>
                        <span className={`ft8__c-num ${snrClass(m.snr)}`}>{m.snr.toFixed(1)}</span>
                        <span className="ft8__c-num">{m.deltaT.toFixed(1)}</span>
                        <span className="ft8__c-num">{m.frequency.toFixed(0)}</span>
                        <span className="ft8__c-num">{m.distanceKm == null ? '' : m.distanceKm.toFixed(0)}</span>
                        <span className="ft8__c-num">{m.bearingDeg == null ? '' : `${m.bearingDeg.toFixed(0)}°`}</span>
                        <span className="ft8__c-country">
                            {[countryFlag(m.countryCode), m.country].filter(Boolean).join(' ')}
                        </span>
                        <span className="ft8__c-cont">{m.continent}</span>
                        <span className="ft8__c-call">
                            {m.txCallsign
                                ? (
                                    <button type="button" className="ft8__call" onClick={() => lookup(m.txCallsign)}>
                                        {m.txCallsign}
                                    </button>
                                )
                                : ''}
                        </span>
                        <span className={`ft8__c-msg${m.isCQ ? ' ft8__c-msg--cq' : ''}`}>{m.message}</span>
                    </div>
                ))}

                <ShowMore shown={page.length} total={rows.length} onMore={() => setShown((n) => n + PAGE)} />
            </div>
        </div>
    );
}
