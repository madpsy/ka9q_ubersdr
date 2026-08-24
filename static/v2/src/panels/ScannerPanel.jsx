// Scanning the markers: leave the dial alone and stop where somebody is talking.
//
// The VFOs panel already scans, and this is the same machine pointed at a much
// longer list. There the channels are the four slots, put there by hand; here
// they are whatever the receiver is being told about — voice activity, spots,
// bookmarks — which on a busy band is dozens of frequencies nobody had to type
// in. What stops it is identical: the squelch's own answer, read from
// `lastGateOpenAt` so the gate's hang cannot carry a signal over from the
// channel before. See lib/scanner.js, which holds the timings both scans use.
//
// Which kinds to scan and whether to stay in the current band are this panel's
// own settings, not the stepper's — see lib/scannerSettings.js for why the two
// selections are deliberately separate and why this one starts at voice only.
//
// `minimal` keeps the button, the note and the list, and drops the two pickers:
// once a scan is set up it is started and stopped, not re-configured.

import React, { useEffect, useMemo, useRef, useState } from '../react.js';
import { Empty, Field, Icon, ShowMore, Switch } from '../components/ui.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import useMarkerNav, { stepToMarker } from '../lib/useMarkerNav.js';
import { MARKER_TOLERANCE_HZ } from '../lib/markerNav.js';
import { NAV_LABELS } from '../lib/markerNavSettings.js';
import {
    SCAN_DWELL_MS, SCAN_MODE_DWELL_MS, SCAN_MODE_SETTLE_MS, SCAN_SETTLE_MS,
    nextScanMarker, scanTargets,
} from '../lib/scanner.js';
import { onScanSettings, saveScanSettings, savedScanSettings } from '../lib/scannerSettings.js';
import { bandForFrequency } from '../lib/bands.js';
import { formatFreqShort } from '../lib/format.js';
import { isIQ } from '../radio/constants.js';

// How many targets the list shows before Show more. A page rather than the lot:
// the dock scrolls, the panel does not, and a voice-heavy 40m evening can put a
// hundred markers in here.
const SCAN_ROWS = 8;

// The shared settings, as state that tracks them.
function useScanSettings() {
    const [settings, setSettings] = useState(savedScanSettings);
    useEffect(() => onScanSettings(setSettings), []);
    return settings;
}

/**
 * The scan: tune each target in turn and stop on the first one carrying a
 * signal.
 *
 * The same shape as the VFOs panel's scan and for the same reasons — the first
 * move is made on the press rather than a dwell later, because the commonest
 * time to press Scan is while listening to something and the channel you are on
 * is the one place a scan has no reason to check; and it stops rather than
 * pausing, so the button never says Scanning while the dial sits still.
 *
 * What differs is where the scan keeps its place. The VFOs have a store saying
 * which slot is active, and the scan reads it back; a marker scan has only the
 * dial, and reading that back is not the same thing — a tune the server clamps,
 * or one the panel has not re-rendered for yet, leaves the dial somewhere that
 * is not the marker we asked for, and a scan that took the dial as its place
 * would pick the same marker again and sit there. So it remembers the frequency
 * it hopped to and carries on from that, whatever the dial ends up reading.
 */
function useScan(radio, list, types) {
    const { meters, squelch, tuning } = radio;
    const [scanning, setScanning] = useState(false);

    const blocked = !types.length
        ? 'No marker kinds selected'
        : isIQ(tuning.mode)
            ? 'No squelch in IQ mode'
            : !squelch.enabled
                ? 'Squelch off, so nothing would stop it'
                : list.length < 2
                    ? 'Needs two markers to scan between'
                    : null;

    // What the timer must read live. The effect is started once per scan and
    // must not be torn down and rebuilt as spots arrive — and a `radio` or a
    // `list` captured at the start would be minutes stale by the time a long
    // scan came round again.
    const live = useRef(null);
    live.current = { radio, list, blocked };

    // Where the scan had got to, in Hz. Not an index: see nextScanMarker.
    const at = useRef(0);

    useEffect(() => {
        if (!scanning) return undefined;
        // When the channel we are on was arrived at, so the gate can be judged
        // on what has been heard since.
        let judgeFrom = 0;
        let handle = null;
        // Moves the scan on, and returns what this hop is worth dwelling for —
        // 0 when there was nowhere to go. A hop that changes mode costs the
        // server a preset reload, so it is timed differently; see
        // SCAN_MODE_DWELL_MS.
        const step = () => {
            const now = live.current;
            const next = nextScanMarker(now.list, at.current);
            if (!next) { setScanning(false); return 0; }
            // A bookmark with no mode of its own is tuned in whatever is live,
            // so it costs no preset reload however far it is from here.
            const changesMode = !!next.mode && next.mode !== now.radio.tuning.mode;
            at.current = next.freq;
            stepToMarker(now.radio.actions, next);
            judgeFrom = performance.now() + (changesMode ? SCAN_MODE_SETTLE_MS : SCAN_SETTLE_MS);
            return changesMode ? SCAN_MODE_DWELL_MS : SCAN_DWELL_MS;
        };
        const tick = () => {
            const now = live.current;
            // Something went out from under the scan — the markers cleared, the
            // squelch switched off, IQ selected. Stopping is the honest answer;
            // carrying on would be stepping with nothing able to halt it.
            if (now.blocked) { setScanning(false); return; }
            if (meters.current.lastGateOpenAt > judgeFrom) { setScanning(false); return; }
            const dwell = step();
            if (dwell) handle = setTimeout(tick, dwell);
        };
        const first = step();
        if (!first) return undefined;
        // A timeout rescheduled per hop rather than one interval, because the
        // dwell is not the same for every hop.
        handle = setTimeout(tick, first);
        return () => clearTimeout(handle);
    }, [scanning, meters]);

    return {
        scanning,
        blocked,
        stop: () => setScanning(false),
        toggle: () => {
            if (scanning) { setScanning(false); return; }
            if (blocked) return;
            // Start from the dial, so the first hop is the next marker up from
            // wherever the operator actually is.
            at.current = tuning.frequency;
            setScanning(true);
        },
    };
}

export default function ScannerPanel({ minimal }) {
    const radio = useRadio();
    const { tuning } = radio;
    const { types, bandOnly } = useScanSettings();
    const markers = useMarkerNav(radio, types);
    const [shown, setShown] = useState(SCAN_ROWS);

    // The band the scan is confined to, or null for the whole spectrum — which
    // is also what `bandOnly` gets outside every ham band, deliberately. See
    // scanTargets.
    const band = bandOnly ? bandForFrequency(tuning.frequency) : null;
    const list = useMemo(
        () => scanTargets(markers.all, { types, bandOnly, dialHz: tuning.frequency }),
        [markers.all, types, bandOnly, tuning.frequency],
    );

    const scan = useScan(radio, list, types);
    const rows = list.slice(0, shown);

    // Picking a target by hand is taking the dial back, so it ends the scan
    // rather than being stepped off a dwell later.
    const go = (m) => { scan.stop(); stepToMarker(radio.actions, m); };

    const note = scan.blocked
        || (scan.scanning
            ? 'Stops on a signal'
            : `${list.length} marker${list.length === 1 ? '' : 's'}${band ? ` on ${band}` : ''}, ${SCAN_DWELL_MS} ms each`);

    return (
        <div className="stack stack--tight">
            <div className="scan">
                <button
                    type="button"
                    className={`scan__btn${scan.scanning ? ' is-scanning' : ''}`}
                    aria-pressed={scan.scanning}
                    disabled={!scan.scanning && !!scan.blocked}
                    title={scan.scanning
                        ? 'Stop scanning'
                        : scan.blocked || `Step through the markers every ${SCAN_DWELL_MS} ms — longer where the mode changes — and stop on the first one the squelch opens on`}
                    onClick={scan.toggle}
                >
                    <Icon.Scan size={13} />
                    {scan.scanning ? 'Scanning' : 'Scan'}
                </button>
                <span className="scan__note">{note}</span>
            </div>

            {/* What is out there, in the order the scan will visit it — so the
                list is the scan's plan rather than a second copy of the spot
                lists. The row under the dial is marked, which is how a stopped
                scan says where it stopped without the button having to. */}
            {rows.length === 0 ? (
                <Empty>
                    {types.length
                        ? `Nothing to scan${band ? ` on ${band}` : ''}`
                        : 'No marker kinds selected'}
                </Empty>
            ) : (
                <div className={`scan__list${scan.scanning ? ' is-scanning' : ''}`}>
                    {rows.map((m) => {
                        // "The dial is on this one", by the same tolerance the
                        // marker bar and the Markers panel use — so a row is lit
                        // exactly when those two say you are on it.
                        const here = Math.abs(m.freq - tuning.frequency) <= MARKER_TOLERANCE_HZ;
                        return (
                            <button
                                key={`${m.type}:${m.freq}`}
                                type="button"
                                className={`scan__row${here ? ' is-active' : ''}`}
                                title={`Tune to ${formatFreqShort(m.freq)}${m.mode ? ` ${m.mode.toUpperCase()}` : ''}`}
                                onClick={() => go(m)}
                            >
                                <span className="scan__freq">{formatFreqShort(m.freq)}</span>
                                <span className="scan__name">{m.name || NAV_LABELS[m.type] || m.type}</span>
                                <span className={`scan__type scan__type--${m.type}`}>
                                    {NAV_LABELS[m.type] || m.type}
                                </span>
                            </button>
                        );
                    })}
                </div>
            )}

            {rows.length > 0 && (
                <ShowMore
                    shown={rows.length}
                    total={list.length}
                    base={SCAN_ROWS}
                    count={false}
                    onMore={() => setShown((n) => n + SCAN_ROWS)}
                    onLess={() => setShown(SCAN_ROWS)}
                />
            )}

            {/* The same chips the Markers panel offers, over a selection of this
                panel's own — a scan and a step are different questions. */}
            {!minimal && (
                <Field label="Scan for" hint={types.length ? undefined : 'nothing selected'}>
                    <div className="chip-row chip-row--wrap">
                        {Object.entries(NAV_LABELS).map(([t, text]) => (
                            <button
                                key={t}
                                type="button"
                                className={`chip chip--button${types.includes(t) ? ' is-active' : ''}`}
                                onClick={() => saveScanSettings({
                                    types: types.includes(t)
                                        ? types.filter((x) => x !== t)
                                        : [...types, t],
                                })}
                            >
                                {text}
                            </button>
                        ))}
                    </div>
                </Field>
            )}

            {!minimal && (
                <Switch
                    checked={bandOnly}
                    onChange={(v) => saveScanSettings({ bandOnly: v })}
                    label="Current band only"
                    title={bandOnly
                        ? (band
                            ? `Only markers on ${band} — the band the dial is in`
                            : 'The dial is outside the ham bands, so the whole spectrum is being scanned')
                        : 'Scanning every marker, wherever it is'}
                />
            )}
        </div>
    );
}
