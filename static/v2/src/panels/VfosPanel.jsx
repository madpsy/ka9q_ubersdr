// All four VFOs at once.
//
// The Receiver panel already has a VfoBar — four buttons, A to D, with the
// frequency each holds in its tooltip. That is the right control when you are
// tuning: it switches, and it costs one row. It is the wrong thing for the
// question this panel answers, which is "where are my four?" — a tooltip shows
// one at a time and only to a mouse, and comparing two of them means hovering
// each in turn and remembering.
//
// So this is the same four VFOs laid out rather than collapsed: frequency, mode
// and filter width for each, with the one in use marked. Clicking a row switches
// to it, which is the same selectVfo the buttons, the spectrum's right-click
// menu and a MIDI mapping all call — a VFO must be switched exactly one way or
// two of them disagree about what "B" holds.
//
// Where the server allows more than one stream, each other row also gets a
// speaker toggle: hear this VFO at the same time as the main one. That is a
// different act from clicking the row — the row is "go there", the speaker is
// "keep it playing while I stay here" — so the two are kept visibly apart: the
// speaker is its own button beside the row, never part of it, and a one-line
// hint at the top says which is which.
//
// Each VFO being heard also gets a squelch and a width slider on its second
// line. A listening VFO starts on the main receiver's squelch and filter and
// follows them until it is given its own — by the slider, its Auto, or for the
// filter its passband edge on the spectrum; the value beside the slider then
// turns into the way back. The main row's sliders are simply main's, so every
// heard row has the same controls in the same places. The squelch slider
// carries the live SNR on its track, which is the row's signal meter too.

import React, { useEffect, useRef, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import {
    LISTEN_IQ_REASON, VFO_IDS, copyVfo, getVfos, isListening, listenEdges, listenOf, listenThreshold,
    listeningVfos, nextScanVfo, onVfosChanged, scannableVfos, selectVfo,
} from '../lib/vfos.js';
import {
    SCAN_DWELL_MS, SCAN_MODE_DWELL_MS, SCAN_MODE_SETTLE_MS, SCAN_SETTLE_MS,
} from '../lib/scanner.js';
import { formatFilterWidth, formatHz } from '../lib/format.js';
import { bandForFrequency } from '../lib/bands.js';
import {
    FILTER_WIDTH_MIN, FILTER_WIDTH_STEP, SQUELCH_MAX, SQUELCH_MIN, SQUELCH_STEP, edgesForWidth, isIQ,
    maxFilterWidth,
} from '../radio/constants.js';
import { useSubReceivers } from '../radio/useSubReceivers.js';
import { vfoColour } from '../lib/vfoColours.js';
import { touchVfo } from '../lib/vfoMarks.js';
import { Icon, Slider } from '../components/ui.jsx';

/**
 * What each slot holds, with the active one taken from live tuning.
 *
 * lib/vfos.js deliberately leaves the active slot's stored copy stale — while a
 * VFO is selected the live receiver *is* that VFO, and the store is written only
 * when you switch away, which saves a write on every turn of the dial. Reading
 * the store for the active slot would show wherever the dial was when it was
 * last selected, which is the one row guaranteed to be wrong.
 */
//
// A listening VFO is the exception to "a slot shows what it holds": it plays in
// the main receiver's mode (the mode lock — see lib/vfos.js) and in main's
// filter or one of its own, so that is what its row shows, with its own saved
// mode kept as `savedMode` for the note saying it will come back to it. `low`,
// `high` and `ownFilter` are the filter it is playing with.
//
// `listen` is false where nothing can be heard alongside the main receiver —
// one VFO on this server, or the main one in IQ. A stored flag is then a
// leftover, not something playing, and the row shows the slot as it is.
function rowsFor(vfos, tuning, listen = false) {
    return VFO_IDS.map((id) => {
        const active = vfos.active === id;
        const listening = listen && isListening(vfos, id);
        const s = active ? tuning : vfos.slots[id];
        if (!s || !(s.frequency > 0)) return { id, active, listening: false, empty: true };
        const shape = listening ? tuning : s;
        const edges = listening
            ? listenEdges(listenOf(vfos, id), tuning)
            : { low: shape.bandwidthLow, high: shape.bandwidthHigh, own: false };
        return {
            id,
            active,
            listening,
            empty: false,
            frequency: s.frequency,
            mode: (shape.mode || '').toUpperCase(),
            savedMode: (s.mode || '').toUpperCase(),
            width: formatFilterWidth(edges.low, edges.high),
            low: edges.low,
            high: edges.high,
            ownFilter: edges.own,
            band: bandForFrequency(s.frequency),
        };
    });
}

// What a listening row says beside its controls, if anything — the one reason
// it is not simply playing, most pressing first. Exported for the tests.
export function listenNote(row, live) {
    if (!row.listening) return null;
    if (live && live.refused) return live.refused;
    if (live && live.waitingPrimary) return 'Waiting for the main stream';
    if (row.savedMode && row.savedMode !== row.mode) {
        return `${row.savedMode} saved · listening in ${row.mode}`;
    }
    return null;
}

// The words on the lit output button: where an Auto VFO has landed, or the pin.
// Exported for the tests.
export function outLabel(out, pan) {
    if (out === 'left') return 'L';
    if (out === 'right') return 'R';
    if (out === 'both') return 'Both';
    if (pan == null) return 'Auto';
    return `Auto·${pan < -0.05 ? 'L' : pan > 0.05 ? 'R' : 'C'}`;
}

// The meter's reach: 0 dB is an idle channel and the strongest signals sit
// around 30 on this server's scale (the v4 SNR is a passband power), so a little
// over that is full scale.
const METER_TOP_DB = 36;

function MiniMeter({ live, title }) {
    const snr = live && live.snr != null ? live.snr : null;
    const level = snr == null ? 0 : Math.max(0, Math.min(1, snr / METER_TOP_DB));
    // Dimmed while the gate is shut, so a row whose VFO is quiet reads as quiet
    // at a glance — the same answer the squelch is giving the speaker.
    const closed = !!live && !live.squelchOpen;
    return (
        <span
            className={`vfos__meter${closed ? ' is-closed' : ''}`}
            role="img"
            aria-label={snr == null ? 'No signal reading yet' : `${snr.toFixed(0)} dB, squelch ${closed ? 'closed' : 'open'}`}
            title={title || (snr == null ? 'No signal reading yet' : `${snr.toFixed(1)} dB SNR${closed ? ' — squelch closed' : ''}`)}
        >
            <span className="vfos__meter-fill" style={{ width: `${Math.round(level * 100)}%` }} />
        </span>
    );
}

// Left to right as the ears are, with Auto and Both between: the two pins are
// at the ends they send the VFO to.
const OUT_OPTIONS = [
    { value: 'left', label: 'L', title: 'Left ear only', aria: 'left ear only' },
    { value: 'auto', label: 'Auto', short: 'Au', title: 'Placed by frequency among the VFOs being heard', aria: 'placed automatically' },
    { value: 'both', label: 'Both', title: 'Both ears, in the middle', aria: 'both ears' },
    { value: 'right', label: 'R', title: 'Right ear only', aria: 'right ear only' },
];

// Where one VFO is heard: four small buttons rather than a chip that opens a
// menu, because the answer is worth seeing without asking for it — and the lit
// Auto says which side it landed on, which is the thing Auto leaves you
// wondering. The same buttons in both views; the compact one only shortens Auto.
function OutButtons({ id, out, pan, short, onChange }) {
    return (
        <span className="vfos__seg" role="group" aria-label={`Where VFO ${id} is heard`}>
            {OUT_OPTIONS.map((o) => {
                const on = o.value === out;
                let label = on ? outLabel(out, pan) : o.label;
                if (short && o.value === 'auto') label = label.replace('Auto', o.short);
                return (
                    <button
                        key={o.value}
                        type="button"
                        className={`vfos__seg-btn${on ? ' is-on' : ''}`}
                        aria-pressed={on}
                        aria-label={`VFO ${id}: ${o.aria}`}
                        title={o.title}
                        onClick={(e) => { e.stopPropagation(); onChange(o.value); }}
                    >
                        {label}
                    </button>
                );
            })}
        </span>
    );
}

/**
 * One of a heard row's two tuning sliders, squelch or filter width: a short
 * label, the slider, and the value it is at.
 *
 * For a listening VFO the value is also the state. Dimmed, it is main's and
 * follows main; once the VFO has a setting of its own the number turns into a
 * button that puts it back — the one place the panel shows the difference is
 * also the way to undo it. The main row's sliders are simply main's controls,
 * so every heard row has the same things in the same places.
 */
function Knob({ kind, id, label, title, slider, value, own, following, reset, extra }) {
    return (
        <span className={`vfos__knob vfos__${kind}`} title={title}>
            <span className="vfos__knob-label" aria-hidden="true">{label}</span>
            <span className="vfos__knob-slider"><Slider {...slider} /></span>
            {own ? (
                <button
                    type="button"
                    className="vfos__knob-val is-own"
                    aria-label={reset.aria}
                    title={reset.title}
                    onClick={(e) => { e.stopPropagation(); reset.onClick(); }}
                >
                    {value}
                    <Icon.Reset size={10} />
                </button>
            ) : (
                <span className={`vfos__knob-val${following ? ' is-following' : ''}`}>{value}</span>
            )}
            {extra}
        </span>
    );
}

// A squelch threshold as the panel says it: "off", or whole dB where it is one.
export function sqLabel(threshold) {
    if (threshold == null) return 'off';
    return `${Number.isInteger(threshold) ? threshold : threshold.toFixed(1)} dB`;
}

/**
 * The scan: step the VFOs on a timer and stop on the first one carrying a
 * signal.
 *
 * "Carrying a signal" is the squelch's own answer, so what stops the scan is
 * exactly what would have let audio through — but taken from `lastGateOpenAt`
 * rather than `squelchOpen`, which is the same reading with the gate's 500 ms
 * hang on it. The hang is what makes the badge steady through the gaps in
 * speech; on a 250 ms dwell it would also still be reading "open" from the
 * previous VFO when the next one is judged, and the scan would stop one place
 * past every signal it found.
 *
 * The scan is deliberately not a hold-and-resume: it stops, and the button goes
 * back to saying Scan, so the panel never shows an active scan that is not
 * moving.
 */
function useScan(radio, vfos) {
    const { squelch, meters, tuning } = radio;
    const [scanning, setScanning] = useState(false);

    // Only VFOs that hold something: switching to an unused slot seeds it with
    // a copy of what is live, so scanning through the empties would quietly
    // fill all four with the same frequency.
    const ids = scannableVfos(vfos, tuning);
    const blocked = ids.length < 2
        ? 'Needs two VFOs in use'
        : isIQ(tuning.mode)
            ? 'No squelch in IQ mode'
            : !squelch.enabled
                ? 'Squelch off, so nothing would stop it'
                : null;

    // What the timer must read live. The interval is started once per scan and
    // must not be torn down and rebuilt on every retune — and a `radio` captured
    // at the start would hand a stale frequency to selectVfo, which stores what
    // it is given into the VFO being left.
    const live = useRef(null);
    live.current = { radio, ids, blocked };

    useEffect(() => {
        if (!scanning) return undefined;
        // When the VFO we are on was arrived at, so the gate can be judged on
        // what has been heard since.
        let judgeFrom = 0;
        let handle = null;
        // Moves the scan on, and returns what this hop is worth dwelling for —
        // 0 when there was nowhere to go. A hop that changes mode costs the
        // server a preset reload, so it is timed differently from one that does
        // not; see SCAN_MODE_DWELL_MS.
        const step = () => {
            const now = live.current;
            const next = nextScanVfo(now.ids, getVfos().active);
            if (!next) { setScanning(false); return 0; }
            const target = getVfos().slots[next];
            const changesMode = !!target && target.mode !== now.radio.tuning.mode;
            selectVfo(now.radio, next);
            judgeFrom = performance.now() + (changesMode ? SCAN_MODE_SETTLE_MS : SCAN_SETTLE_MS);
            return changesMode ? SCAN_MODE_DWELL_MS : SCAN_DWELL_MS;
        };
        const tick = () => {
            const now = live.current;
            // Something went out from under the scan — the last-but-one VFO
            // cleared, the squelch switched off, IQ selected. Stopping is the
            // honest answer; carrying on would be stepping with nothing able to
            // halt it.
            if (now.blocked) { setScanning(false); return; }
            if (meters.current.lastGateOpenAt > judgeFrom) { setScanning(false); return; }
            const dwell = step();
            if (dwell) handle = setTimeout(tick, dwell);
        };
        // The first move is made on the press, not a dwell later.
        //
        // Pressing Scan is "leave here and go looking", and the commonest time
        // to press it is while listening to something — which is exactly the
        // case where dwelling first and then testing the gate found the signal
        // already in the speaker, called it a stop, and never moved at all.
        // The VFO you started on is the one place a scan has no reason to
        // check: you were already there.
        const first = step();
        if (!first) return undefined;
        // A timeout rescheduled per hop rather than one interval, because the
        // dwell is no longer the same for every hop.
        handle = setTimeout(tick, first);
        return () => clearTimeout(handle);
    }, [scanning, meters]);

    return {
        scanning,
        ids,
        blocked,
        stop: () => setScanning(false),
        toggle: () => setScanning((on) => (on ? false : !blocked)),
    };
}


export default function VfosPanel({ minimal }) {
    const radio = useRadio();
    const { tuning } = radio;
    // Not `setVfos`: lib/vfos.js exports one of those and it *writes the
    // store*. This only mirrors it into local state.
    const [vfos, setLocal] = useState(getVfos);

    useEffect(() => onVfosChanged(setLocal), []);

    const scan = useScan(radio, vfos);

    // Simultaneous VFOs, where the server allows them. At a limit of one this
    // panel is exactly what it was before they existed: no hint, no speakers,
    // and a row that is one button.
    const { subs, snap } = useSubReceivers(8);
    const limit = snap.limit || 1;
    const multi = limit > 1;
    // In IQ the main receiver's left and right are I and Q, so there is no
    // stereo field to share out and nothing else is played. The speakers stay
    // on show, disabled with the reason, rather than the panel changing shape
    // every time the mode does.
    const mainIQ = isIQ(tuning.mode);
    const canListen = multi && !mainIQ;
    const extras = canListen ? listeningVfos(vfos).length : 0;
    const spare = limit - 1;
    const full = extras >= spare;
    const rows = rowsFor(vfos, tuning, canListen);
    const anyListening = rows.some((v) => v.listening);

    // Picking a VFO by hand is taking the dial back, so it ends the scan rather
    // than being stepped off 250 ms later. A listening one swaps with the main
    // receiver rather than replacing it — see selectVfo.
    const pick = (id) => { scan.stop(); selectVfo(radio, id); };

    // The main receiver's sound is the Audio panel's volume and mute — the same
    // ones, not a copy — so that turning it down here and there is one setting.
    // Its side of the stereo field is stored with the VFOs, like the others'.
    const audio = radio.audio || { volume: 1, muted: false };
    const mainThreshold = radio.squelch && radio.squelch.enabled ? radio.squelch.threshold : null;
    const mainLive = () => {
        const m = radio.meters && radio.meters.current;
        return m ? { snr: m.snr, squelchOpen: m.squelchOpen } : null;
    };
    const sound = (v) => {
        if (v.active) {
            return {
                out: listenOf(vfos, v.id).out,
                pan: snap.mainPan,
                vol: audio.volume,
                muted: audio.muted,
                live: mainLive(),
                setVolume: (x) => radio.actions.setVolume(x),
                setMuted: (on) => radio.actions.setMuted(on),
                setWidth: (w) => radio.actions.setBandwidth(...edgesForWidth(tuning.mode, w, tuning)),
                threshold: mainThreshold,
                sqOwn: false,
                setSquelch: (x) => radio.actions.setSquelch(x),
                autoSquelch: () => radio.actions.autoSquelch(),
            };
        }
        const l = listenOf(vfos, v.id);
        const live = snap.vfos[v.id] || null;
        return {
            out: l.out,
            pan: live ? live.pan : null,
            vol: l.vol,
            muted: l.muted,
            live,
            setVolume: (x) => subs.setVolume(v.id, x),
            setMuted: (on) => subs.setMuted(v.id, on),
            // From the filter it is playing with, so a VFO with a shift of its
            // own keeps it; one that lands back on main's filter follows main
            // again (lib/vfos.js withListenFilter).
            setWidth: (w) => {
                touchVfo(v.id);
                subs.setFilter(v.id, edgesForWidth(tuning.mode, w, { bandwidthLow: v.low, bandwidthHigh: v.high }));
            },
            follow: () => subs.setFilter(v.id, null),
            // The stored setting, not the engine's: the slider moves at once.
            threshold: listenThreshold(l, mainThreshold).threshold,
            sqOwn: listenThreshold(l, mainThreshold).own,
            setSquelch: (x) => { touchVfo(v.id); subs.setSquelch(v.id, x <= SQUELCH_MIN ? 'off' : x); },
            autoSquelch: () => { touchVfo(v.id); subs.autoSquelch(v.id); },
            followSquelch: () => subs.setSquelch(v.id, null),
        };
    };
    const mainWidth = Math.abs((tuning.bandwidthHigh || 0) - (tuning.bandwidthLow || 0));
    const setOut = (id, out) => { touchVfo(id); subs.setOutput(id, out); };

    const rowButton = (v) => (
        <button
            key={multi ? undefined : v.id}
            type="button"
            className={`vfos__row${v.active ? ' is-active' : ''}${v.listening ? ' is-listening' : ''}`}
            aria-pressed={v.active}
            // An unused slot takes a copy of what is live rather than
            // doing nothing, which is what the Receiver panel's
            // buttons do and what a radio does.
            title={v.active
                ? `VFO ${v.id} — in use`
                : v.listening
                    ? `Make VFO ${v.id} the main receiver — swaps with ${vfos.active}, which carries on playing`
                    : v.empty
                        ? `Switch to VFO ${v.id} — unused, so it takes the current settings`
                        : `Switch to VFO ${v.id}`}
            onClick={() => pick(v.id)}
        >
            {/* Every row emits the same cells, whether or not it
                has anything to put in them. Rendering a cell only
                when it has content lets the ones after it slide
                along: a VFO outside a ham band has no band to show,
                so its mode and filter width ended up somewhere the
                rows above and below did not have them, and four
                frequencies that cannot be read down a column are the
                one thing this panel exists to avoid. */}
            {/* A VFO being heard wears its colour on its letter — the
                same one its passband and marker carry on the spectrum —
                so a row and a passband can be matched without reading
                either. Only while heard: a parked VFO is not on the
                spectrum in that colour, and the letter is not a key to
                anything. */}
            <span
                className={`vfos__id${v.listening || (v.active && anyListening) ? ' vfos__badge' : ''}`}
            >
                {v.id}
            </span>
            <span className={`vfos__freq${v.empty ? ' is-empty' : ''}`}>
                {v.empty ? 'unused' : formatHz(v.frequency)}
            </span>
            <span className="vfos__mode">{v.empty ? '' : v.mode}</span>
            {/* The filter width and the band qualify the frequency
                rather than being it, so they are what a cut-down
                view drops first. */}
            {!minimal && <span className="vfos__width">{v.empty ? '' : v.width}</span>}
            {!minimal && <span className="vfos__band">{v.empty ? '' : (v.band || '')}</span>}
            {v.active && anyListening && <span className="vfos__main">MAIN</span>}
        </button>
    );

    // "Hear this one as well". Never disabled for one already playing — it
    // must always be possible to stop — and otherwise disabled, not hidden, at
    // the limit or in IQ, with the reason as its tooltip. aria-disabled rather
    // than `disabled` so the tooltip still shows and the button can still be
    // focused to read it.
    const speaker = (v) => {
        const blocked = !canListen
            ? LISTEN_IQ_REASON
            : !v.listening && full
                ? `${extras} of ${spare} in use on this receiver`
                : null;
        return (
            <button
                type="button"
                className={`vfos__spk${v.listening ? ' is-on' : ''}${blocked ? ' is-disabled' : ''}`}
                aria-pressed={v.listening}
                aria-disabled={!!blocked}
                aria-label={`Listen to VFO ${v.id} at the same time`}
                title={blocked
                    || (v.listening
                        ? `Stop listening to VFO ${v.id}`
                        : v.empty
                            ? `Listen to VFO ${v.id} at the same time — unused, so it starts where the receiver is`
                            : `Listen to VFO ${v.id} at the same time as ${vfos.active}`)}
                // Its own act, never the row's: it sits beside the row rather
                // than in it, and stops here in case it is ever nested.
                onClick={(e) => {
                    if (e && e.stopPropagation) e.stopPropagation();
                    if (blocked) return;
                    if (!v.listening) touchVfo(v.id);
                    subs.setListening(v.id, !v.listening);
                }}
            >
                <Icon.Volume size={14} />
            </button>
        );
    };

    // The second line of the expanded view, in two rows: how the VFO is heard
    // (where, whether, how loud), then what it lets through (squelch and
    // filter width) — two sliders side by side, so the rows of four VFOs line
    // up in columns. On a narrow dock the pair wraps, one slider to a row.
    const soundLine = (v, s, note, refused) => {
        const snr = s.live && s.live.snr != null ? s.live.snr : null;
        const open = !!(s.live && s.live.squelchOpen);
        const sqText = sqLabel(s.threshold);
        const mainSq = sqLabel(mainThreshold);
        const width = Math.abs(v.high - v.low);
        const max = maxFilterWidth(tuning.mode);
        const widthText = formatFilterWidth(0, width);
        const mainWidthText = formatFilterWidth(0, mainWidth);
        const main = v.active;
        return (
            <div className="vfos__ctl">
                <div className="vfos__ctl-row">
                    <OutButtons id={v.id} out={s.out} pan={s.pan} onChange={(o) => setOut(v.id, o)} />
                    <button
                        type="button"
                        className={`vfos__mute${s.muted ? ' is-on' : ''}`}
                        aria-pressed={s.muted}
                        aria-label={`Mute VFO ${v.id}`}
                        title={s.muted ? `Unmute VFO ${v.id}` : `Mute VFO ${v.id}`}
                        onClick={() => s.setMuted(!s.muted)}
                    >
                        {s.muted ? <Icon.Mute size={14} /> : <Icon.Volume size={14} />}
                    </button>
                    <span className="vfos__vol" title={`VFO ${v.id} volume: ${Math.round(s.vol * 100)}`}>
                        <Slider
                            value={Math.round(s.vol * 100)}
                            min={0}
                            max={100}
                            disabled={s.muted}
                            onChange={(x) => s.setVolume(x / 100)}
                        />
                    </span>
                </div>
                <div className="vfos__ctl-row">
                    <Knob
                        kind="squelch"
                        id={v.id}
                        label="SQ"
                        title={[
                            main
                                ? `VFO ${v.id} squelch: ${sqText}`
                                : s.sqOwn
                                    ? `VFO ${v.id} has its own squelch: ${sqText} (${vfos.active} ${mainSq})`
                                    : `VFO ${v.id} uses ${vfos.active}'s squelch (${mainSq}) — move this to give it its own`,
                            snr == null ? 'no signal reading yet' : `SNR ${snr.toFixed(1)} dB${s.threshold == null ? '' : `, ${open ? 'open' : 'closed'}`}`,
                        ].join(' — ')}
                        slider={{
                            value: s.threshold == null ? SQUELCH_MIN : s.threshold,
                            min: SQUELCH_MIN,
                            max: SQUELCH_MAX,
                            step: SQUELCH_STEP,
                            onChange: s.setSquelch,
                            // The live SNR on the track, in the gate's colour:
                            // the row's meter and its squelch state in one.
                            marker: snr,
                            markerTone: s.threshold != null && !open ? 'closed' : 'open',
                        }}
                        value={sqText}
                        own={!main && s.sqOwn}
                        following={!main}
                        reset={{
                            aria: `VFO ${v.id}: use ${vfos.active}'s squelch again`,
                            title: `Back to ${vfos.active}'s squelch (${mainSq})`,
                            onClick: s.followSquelch,
                        }}
                        extra={(
                            <button
                                type="button"
                                className="vfos__auto"
                                aria-label={`VFO ${v.id}: set the squelch automatically`}
                                title={`Set VFO ${v.id}'s squelch just above the noise it is hearing`}
                                disabled={snr == null}
                                onClick={(e) => { e.stopPropagation(); s.autoSquelch(); }}
                            >
                                Auto
                            </button>
                        )}
                    />
                    <Knob
                        kind="bw"
                        id={v.id}
                        label="BW"
                        title={main
                            ? `VFO ${v.id} filter width: ${widthText}`
                            : v.ownFilter
                                ? `VFO ${v.id} has its own filter: ${widthText} (${vfos.active} ${mainWidthText})`
                                : `VFO ${v.id} uses ${vfos.active}'s filter (${widthText}) — move this or drag its passband edge to give it its own`}
                        slider={{
                            value: Math.max(FILTER_WIDTH_MIN, Math.min(max, Math.round(width))),
                            min: FILTER_WIDTH_MIN,
                            max,
                            step: FILTER_WIDTH_STEP,
                            onChange: s.setWidth,
                            // Main's width on the track, so how the two compare
                            // shows without reading either number.
                            marker: main ? null : mainWidth,
                        }}
                        value={widthText}
                        own={!main && v.ownFilter}
                        following={!main}
                        reset={{
                            aria: `VFO ${v.id}: use ${vfos.active}'s filter again`,
                            title: `Back to ${vfos.active}'s filter (${mainWidthText})`,
                            onClick: s.follow,
                        }}
                    />
                </div>
                {note && <span className={`vfos__note${refused ? ' is-refused' : ''}`}>{note}</span>}
            </div>
        );
    };

    const item = (v) => {
        const heard = v.listening || (v.active && anyListening);
        const s = heard ? sound(v) : null;
        const live = v.active ? null : snap.vfos[v.id] || null;
        const note = listenNote(v, live);
        const refused = !!(live && live.refused);
        // Main takes the accent it already wears; a listening VFO its colour.
        const colour = v.active ? 'var(--accent)' : vfoColour(v.id);
        return (
            <div
                key={v.id}
                className={`vfos__item${heard ? ' is-heard' : ''}${refused ? ' is-refused' : ''}`}
                style={heard ? { '--vfo-colour': colour } : undefined}
            >
                <div className="vfos__line">
                    {rowButton(v)}
                    {v.active ? <span className="vfos__ctl-gap" /> : speaker(v)}
                    {/* Compact: the same answers in one line — the meter for
                        a VFO beside the main one, and where each is heard. */}
                    {minimal && v.listening && <MiniMeter live={live} title={refused ? note : null} />}
                    {minimal && heard && (
                        <OutButtons id={v.id} out={s.out} pan={s.pan} short onChange={(o) => setOut(v.id, o)} />
                    )}
                </div>
                {!minimal && heard && soundLine(v, s, note, refused)}
            </div>
        );
    };

    return (
        <div className="stack stack--tight">
            {/* The two things a row offers, said once rather than learned by
                accident: clicking it goes there, the speaker plays it as well. */}
            {canListen && (
                <div className="vfos__hint">
                    <span className="vfos__hint-text">
                        Click a VFO to switch · <Icon.Volume size={12} /> to listen at the same time
                    </span>
                    <span className="vfos__hint-count" title={`Up to ${spare} VFO${spare === 1 ? '' : 's'} can play beside the main one on this receiver`}>
                        {extras} of {spare} extra
                    </span>
                </div>
            )}
            <div className={`vfos${scan.scanning ? ' is-scanning' : ''}${multi && minimal ? ' is-compact' : ''}`}>
                {multi ? rows.map(item) : rows.map(rowButton)}
            </div>
            {/* Stepping the VFOs on a timer until something is heard. Above the
                copy row because it acts on all four, which is what this panel
                is; the copy row acts on one. */}
            <div className="vfos__scan">
                <button
                    type="button"
                    className={`vfos__scan-btn${scan.scanning ? ' is-scanning' : ''}`}
                    aria-pressed={scan.scanning}
                    disabled={!scan.scanning && !!scan.blocked}
                    title={scan.scanning
                        ? 'Stop scanning'
                        : scan.blocked || `Step through the VFOs every ${SCAN_DWELL_MS} ms — longer where the mode changes — and stop on the first one the squelch opens on`}
                    onClick={scan.toggle}
                >
                    {scan.scanning ? 'Scanning' : 'Scan'}
                </button>
                <span className="vfos__scan-note">
                    {scan.blocked || (scan.scanning ? 'Stops on a signal' : `${scan.ids.length} VFOs, ${SCAN_DWELL_MS} ms each`)}
                </span>
            </div>
            {/* Sending the current settings somewhere, as opposed to going
                there — which is what clicking a row does. The two are easy to
                confuse and the mistake is expensive, so the direction is spelled
                out rather than left to an icon: "Copy A to" and then the VFOs
                that are not A. */}
            {!minimal && (
                <div className="vfos__copy">
                    <span className="vfos__copy-label">Copy {vfos.active} to</span>
                    {VFO_IDS.filter((id) => id !== vfos.active).map((id) => (
                        <button
                            key={id}
                            type="button"
                            className="vfos__copy-btn"
                            title={`Put the current frequency, mode and filter into VFO ${id}, and stay on ${vfos.active}`}
                            onClick={() => copyVfo(radio, id)}
                        >
                            {id}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
