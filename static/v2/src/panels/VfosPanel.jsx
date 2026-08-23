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

import React, { useEffect, useRef, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import {
    VFO_IDS, copyVfo, getVfos, nextScanVfo, onVfosChanged, scannableVfos, selectVfo,
} from '../lib/vfos.js';
import { formatFilterWidth, formatHz } from '../lib/format.js';
import { bandForFrequency } from '../lib/bands.js';
import { isIQ } from '../radio/constants.js';

// How long the scan sits on each VFO before moving on. Short enough that four
// channels come round in a second, long enough that the server's audio has
// arrived and been metered — the gate is judged on packets, not on the tune.
const SCAN_DWELL_MS = 250;

// What a hop costs when it also changes mode, which is a different kind of hop.
//
// A mode change makes the server reload radiod's preset, which rebuilds the
// filter and restarts the demodulator, and the server holds the audio gate shut
// until radiod confirms the new channel — around a fifth of a second in which
// there is deliberately nothing to hear. Judging a channel inside that window
// finds silence whoever is on it, so a busy VFO would be stepped over rather
// than stopped on. These wait it out and then leave a run of packets to judge.
const SCAN_MODE_DWELL_MS = 600;
const SCAN_MODE_SETTLE_MS = 350;

/**
 * What each slot holds, with the active one taken from live tuning.
 *
 * lib/vfos.js deliberately leaves the active slot's stored copy stale — while a
 * VFO is selected the live receiver *is* that VFO, and the store is written only
 * when you switch away, which saves a write on every turn of the dial. Reading
 * the store for the active slot would show wherever the dial was when it was
 * last selected, which is the one row guaranteed to be wrong.
 */
function rowsFor(vfos, tuning) {
    return VFO_IDS.map((id) => {
        const active = vfos.active === id;
        const s = active ? tuning : vfos.slots[id];
        if (!s || !(s.frequency > 0)) return { id, active, empty: true };
        return {
            id,
            active,
            empty: false,
            frequency: s.frequency,
            mode: (s.mode || '').toUpperCase(),
            width: formatFilterWidth(s.bandwidthLow, s.bandwidthHigh),
            band: bandForFrequency(s.frequency),
        };
    });
}

// After a switch, the packets already in flight were produced on the VFO we
// just left, so the gate they open is the old channel's, not this one's. A
// signal on B would otherwise stop the scan on C, one hop late and every time.
// Judged from a moment after the tune instead — well inside a 250 ms dwell, so
// there is still a run of packets left to hear this channel on.
const SCAN_SETTLE_MS = 100;

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
    const rows = rowsFor(vfos, tuning);

    return (
        <div className="stack stack--tight">
            <div className={`vfos${scan.scanning ? ' is-scanning' : ''}`}>
                {rows.map((v) => (
                    <button
                        key={v.id}
                        type="button"
                        className={`vfos__row${v.active ? ' is-active' : ''}`}
                        aria-pressed={v.active}
                        // An unused slot takes a copy of what is live rather than
                        // doing nothing, which is what the Receiver panel's
                        // buttons do and what a radio does.
                        title={v.active
                            ? `VFO ${v.id} — in use`
                            : v.empty
                                ? `Switch to VFO ${v.id} — unused, so it takes the current settings`
                                : `Switch to VFO ${v.id}`}
                        // Picking a VFO by hand is taking the dial back, so it
                        // ends the scan rather than being stepped off 250 ms later.
                        onClick={() => { scan.stop(); selectVfo(radio, v.id); }}
                    >
                        {/* Every row emits the same cells, whether or not it
                            has anything to put in them. Rendering a cell only
                            when it has content lets the ones after it slide
                            along: a VFO outside a ham band has no band to show,
                            so its mode and filter width ended up somewhere the
                            rows above and below did not have them, and four
                            frequencies that cannot be read down a column are the
                            one thing this panel exists to avoid. */}
                        <span className="vfos__id">{v.id}</span>
                        <span className={`vfos__freq${v.empty ? ' is-empty' : ''}`}>
                            {v.empty ? 'unused' : formatHz(v.frequency)}
                        </span>
                        <span className="vfos__mode">{v.empty ? '' : v.mode}</span>
                        {/* The filter width and the band qualify the frequency
                            rather than being it, so they are what a cut-down
                            view drops first. */}
                        {!minimal && <span className="vfos__width">{v.empty ? '' : v.width}</span>}
                        {!minimal && <span className="vfos__band">{v.empty ? '' : (v.band || '')}</span>}
                    </button>
                ))}
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
