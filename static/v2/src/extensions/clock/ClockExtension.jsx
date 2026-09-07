// Time signal decoder — WWV, WWVH and WWVB.
//
// The decoding is the server's: this attaches the `clock` audio extension to
// the session's audio (see ../useAudioExtension.js) and reads the JSON events
// that come back (see ./frames.js). What arrives is a broadcast timestamp, how
// far the receiver's clock is from it, and — the part worth having — a running
// account of the decoder's own acquisition.
//
// This panel is unlike the other decoders in one way that shapes all of it: a
// lock takes MINUTES. Two clean minutes to anchor the frame and two more for
// the voter, on a signal that fades. For most of the time anyone spends
// looking at it there is no time to show, so the interesting question is not
// "what did it decode" but "is it getting anywhere, and if not, why not". That
// is what the funnel, the symbol strip and the alignment display are for, and
// why they are not hidden behind a debug switch.
//
// The two views:
//
//   minimal   the reading. Station, lock state, the time in this browser's
//             timezone and in UTC, how far the clock is out, and how much to
//             trust it. Nothing else.
//   expanded  all of it — the alignment overlay, the classified-second strip,
//             the acquisition funnel, the frame's own flag bits and DUT1, and
//             the raw telemetry underneath.
//
// Both views show the time in the browser's own timezone as well as UTC, which
// is a sounder thing to do than it first looks: a browser's CLOCK and its
// TIMEZONE are separate settings, so a machine an hour out still knows which
// zone it is in. The instant therefore comes entirely from the radio and only
// the zone from this machine, and neither side contributes what it is bad at.
// Both clocks tick — see the note by the reading block for why they have to.
//
// The offset is the receiver's, not the browser's, and the panel says so. The
// server measures it against RTP packet arrival on the receiver host, which is
// the best reference in the chain; the browser's own clock is shown next to it
// in the expanded view, clearly separated, because it is a different clock and
// is measured through a websocket rather than a decoder.

import React, { memo, useEffect, useMemo, useState } from '../../react.js';
import { useRadio } from '../../radio/RadioContext.jsx';
import { Button, Empty, Icon, Readout } from '../../components/ui.jsx';
import { useAudioExtension } from '../useAudioExtension.js';
import {
    CLOCK_BANDWIDTH, CLOCK_FREQUENCIES, CLOCK_MODE, STRIP_LENGTH, SYMBOL_LABELS, SYMBOL_NAMES,
    alignmentSeries, appendSecond, correctedNowMs, decodeFrame, formatClock, formatDate,
    formatDay, formatDut1, formatOffset, frameFlags, funnelStages, localIsUtc, offsetSense,
    offsetTone, polylinePoints, stateLabel, stateTone, stationFor, stationLabel, symbolTone,
    tunedClockOption, zoneLabel,
} from './frames.js';

// The alignment plot, in the SVG's own coordinates.
const PLOT_W = 600;
const PLOT_H = 90;

// A decode is only as current as the last event. Past this the readout is
// showing history, and saying nothing about that would be claiming a lock that
// may already be gone — the decoder demotes itself, but only on its own next
// second, and a dead audio stream produces no seconds at all.
const STALE_MS = 90_000;

// ── the alignment overlay ───────────────────────────────────────────────────

// Memoised: a `second` event arrives every second carrying two 200-point
// arrays, and without this every one of them would reconcile the whole panel
// including the funnel and the strip.
const Alignment = memo(function Alignment({ second }) {
    const series = useMemo(() => alignmentSeries(second), [second]);
    if (!series) {
        return (
            <div className="ck__plot ck__plot--empty">
                <Empty>No second classified yet.</Empty>
            </div>
        );
    }

    const envelope = polylinePoints(series.envelope, PLOT_W, PLOT_H);
    const expected = series.expected
        ? polylinePoints(series.expected, PLOT_W, PLOT_H, series.shift)
        : '';

    const shiftMs = series.seriesRate ? (series.shift * 1000) / series.seriesRate : 0;
    const symbolName = SYMBOL_NAMES[series.symbol] || 'unclassified';
    // Composed rather than written as JSX text around an expression. A bare
    // word in text position is indistinguishable from an identifier to
    // test/unresolved.js, which flags it because lib/measure.js exports one
    // called `drift` — and that check earns its false positives by catching
    // real "X is not defined" blanks, so this defers to it.
    const driftLabel = `drift ${shiftMs >= 0 ? '+' : '−'}${Math.abs(shiftMs).toFixed(0)} ms`;

    return (
        <div className="ck__plot">
            <svg
                className="ck__plot-svg"
                viewBox={`0 0 ${PLOT_W} ${PLOT_H}`}
                preserveAspectRatio="none"
                role="img"
                aria-label={`One second of received envelope, matched as a ${symbolName}`}
            >
                {/* Every 100 ms, so the pulse lengths that separate the symbols
                    — 170, 470 and 770 ms — can be read off the plot. */}
                {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
                    <line
                        key={i}
                        className="ck__plot-grid"
                        x1={(PLOT_W / 10) * i} y1="0"
                        x2={(PLOT_W / 10) * i} y2={PLOT_H}
                    />
                ))}
                {expected && <polyline className="ck__plot-expected" points={expected} />}
                <polyline className="ck__plot-envelope" points={envelope} />
            </svg>
            <div className="ck__plot-legend">
                <span className="ck__plot-key ck__plot-key--envelope">Received</span>
                <span className="ck__plot-key ck__plot-key--expected">
                    Expected ({symbolName})
                </span>
                <span className="ck__plot-gap" />
                <span
                    className="ck__plot-shift"
                    title="Where the received pulse sits against the template's nominal position. Near zero on a steady stream; non-zero while the decoder absorbs sample-clock drift, and the template above is drawn shifted by it so the two stay honest to each other."
                >
                    {driftLabel}
                </span>
            </div>
        </div>
    );
});

// ── the classified-second strip ─────────────────────────────────────────────

const Strip = memo(function Strip({ strip }) {
    // Padded to a full minute so the cells do not resize as it fills, and so
    // the marker pattern sits in the same place once it is there.
    const pad = Math.max(0, STRIP_LENGTH - strip.length);

    return (
        <div className="ck__strip" role="img" aria-label="The last minute of classified seconds">
            {Array.from({ length: pad }, (_, i) => (
                <span key={`pad${i}`} className="ck__cell ck__cell--none" />
            ))}
            {strip.map((cell) => (
                <span
                    key={cell.id}
                    className={`ck__cell ck__cell--${symbolTone(cell)}`}
                    title={`${SYMBOL_NAMES[cell.symbol] || 'unclassified'}, margin ${cell.confidence.toFixed(2)}${
                        cell.secondOfFrame >= 0 ? ` — second ${cell.secondOfFrame}` : ''}`}
                >
                    {SYMBOL_LABELS[cell.symbol] || '·'}
                </span>
            ))}
        </div>
    );
});

// ── the acquisition funnel ──────────────────────────────────────────────────

function Funnel({ diag, station }) {
    const stages = funnelStages(diag, station);
    if (!stages.length) return null;

    // The hint for the first failing stage only. Showing every stage's hint at
    // once is four paragraphs telling you to fix four things when three of them
    // are consequences of the first.
    const first = stages.find((s) => s.first);

    return (
        <div className="ck__funnel">
            <div className="ck__funnel-row">
                {stages.map((s) => (
                    <div
                        key={s.id}
                        className={`ck__stage${s.ok ? ' is-ok' : ''}${s.first ? ' is-first' : ''}${s.blocked ? ' is-blocked' : ''}`}
                    >
                        <span className="ck__stage-mark" aria-hidden="true">
                            {s.ok ? '●' : (s.first ? '○' : '·')}
                        </span>
                        <span className="ck__stage-label">{s.label}</span>
                        {s.detail && <span className="ck__stage-detail">{s.detail}</span>}
                    </div>
                ))}
            </div>
            {first && first.hint && <div className="note note--tight ck__hint">{first.hint}</div>}
        </div>
    );
}

// ── the panel ───────────────────────────────────────────────────────────────

export default function ClockExtension({ minimal }) {
    const { running, audioState, tuning, actions } = useRadio();
    // Attaching needs the audio session, not merely the power switch — the
    // server looks the session up by the UUID the socket was opened with.
    const live = running && audioState === 'open';

    const [decoding, setDecoding] = useState(false);
    const [state, setState] = useState('nosignal');
    const [station, setStation] = useState('unknown');
    const [time, setTime] = useState(null);
    const [frame, setFrame] = useState(null);
    const [second, setSecond] = useState(null);
    const [strip, setStrip] = useState([]);
    const [diag, setDiag] = useState(null);
    // The browser's own error, sampled when a decode arrives. Kept apart from
    // the decoder's offset because it is a different clock measured a different
    // way — see the note at the top.
    const [browserOffset, setBrowserOffset] = useState(null);
    const [now, setNow] = useState(() => Date.now());

    const onResult = (ev) => {
        switch (ev.type) {
            case 'state':
                setState(ev.state);
                if (ev.station) setStation(ev.station);
                break;
            case 'time':
                setTime({ ...ev, at: Date.now() });
                if (ev.station) setStation(ev.station);
                if (Number.isFinite(ev.utc_ms)) setBrowserOffset(ev.utc_ms - Date.now());
                break;
            case 'frame':
                setFrame(ev);
                break;
            case 'second':
                setSecond(ev);
                setStrip((prev) => appendSecond(prev, ev));
                if (ev.station) setStation(ev.station);
                break;
            case 'diag':
                setDiag(ev);
                if (ev.state) setState(ev.state);
                break;
            default:
                break;
        }
    };

    // No parameters: the server takes the sample rate from the session and the
    // station from the dial, so there is nothing here whose change should tear
    // the decoder down — which matters more here than anywhere else, since a
    // re-attach costs four minutes of acquisition.
    const { state: attachState, error } = useAudioExtension({
        name: 'clock',
        params: undefined,
        active: decoding && live,
        parse: decodeFrame,
        onResult,
    });

    // Powering the receiver off takes the audio session with it. An audio
    // *reconnect* is not that: the hook re-attaches and decoding stays on.
    useEffect(() => { if (!running && decoding) setDecoding(false); }, [running, decoding]);

    // The readouts are the decoder's and must not outlive it.
    useEffect(() => {
        if (decoding) return;
        setState('nosignal');
        setStation('unknown');
        setTime(null);
        setFrame(null);
        setSecond(null);
        setStrip([]);
        setDiag(null);
        setBrowserOffset(null);
    }, [decoding]);

    // Drives the staleness check and the live clock, and only while decoding —
    // an interval left running in a closed panel is a leak that costs a render
    // a second for the rest of the session.
    useEffect(() => {
        if (!decoding) return undefined;
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [decoding]);

    const stale = !!time && now - time.at > STALE_MS;
    const locked = state === 'locked' && !!time && !stale;

    const dialStation = stationFor(tuning.frequency);
    const tuned = tunedClockOption(tuning.frequency);
    const wrongMode = tuning.mode !== CLOCK_MODE;
    // The one setup mistake that produces silence with no other symptom.
    const narrow = !wrongMode && tuning.bandwidthHigh < 2400 && dialStation !== 'wwvb';

    const tuneTo = (option) => {
        actions.tuneTo({
            frequency: option.hz,
            mode: CLOCK_MODE,
            bandwidthLow: CLOCK_BANDWIDTH.low,
            bandwidthHigh: CLOCK_BANDWIDTH.high,
        });
        actions.ensureVisible(option.hz);
    };

    const statusLabel = !decoding
        ? 'Stopped'
        : (attachState === 'error' ? 'Error'
            : (attachState !== 'running' ? 'Starting…' : stateLabel(state)));
    const statusTone = !decoding
        ? 'off'
        : (attachState === 'error' ? 'bad'
            : (attachState !== 'running' ? 'wait' : stateTone(state)));

    const offsetMs = locked && Number.isFinite(time.offset_ms) ? time.offset_ms : null;
    const quality = locked && Number.isFinite(time.quality) ? time.quality : null;

    const transport = decoding
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
                onClick={() => setDecoding(true)}
                disabled={!live}
                icon={<Icon.Power size={13} />}
                title={live
                    ? 'Start decoding the time code in this receiver’s audio'
                    : 'Start the receiver first — the decoder runs on your audio session'}
            >
                Start
            </Button>
        );

    // ── the reading, shared by both views ───────────────────────────────────
    //
    // Two clocks, both ticking, both driven by the radio: a `time` event is one
    // snapshot a minute on WWV, so showing it verbatim would leave the headline
    // frozen for a minute at a time on a panel about what the time is.
    //
    // The local one is the browser's zone applied to the radio's instant. That
    // is the honest split — a browser's clock can be an hour out while its
    // timezone is still correct, because they are separate settings — so each
    // side contributes only what it is good for.
    const correctedMs = locked ? correctedNowMs(time, now) : null;
    const bothSame = localIsUtc();
    const localName = bothSame ? 'UTC' : zoneLabel(undefined);
    const dayLine = correctedMs != null ? formatDay(correctedMs, undefined) : '';

    const reading = (
        <div className={`ck__reading${locked ? ' is-locked' : ''}`}>
            <div className="ck__clocks">
                <div className="ck__clock">
                    <div
                        className="ck__clock-time"
                        title="The broadcast time, in this browser’s timezone. The instant comes from the radio; only the zone comes from this machine."
                    >
                        {correctedMs != null ? formatClock(correctedMs, undefined) : '--:--:--'}
                    </div>
                    <div className="ck__clock-label">{localName}</div>
                </div>
                {!bothSame && (
                    <div className="ck__clock ck__clock--utc">
                        <div className="ck__clock-time" title="The broadcast time as sent">
                            {correctedMs != null ? formatClock(correctedMs, 'UTC') : '--:--:--'}
                        </div>
                        <div className="ck__clock-label">UTC</div>
                    </div>
                )}
            </div>
            {dayLine && <div className="ck__day">{dayLine}</div>}
            <div className="ck__offsets">
                <Readout
                    label="Receiver clock"
                    value={formatOffset(offsetMs)}
                    tone={offsetTone(offsetMs)}
                    reserve
                />
                {offsetMs != null && (
                    <span className="ck__sense">{offsetSense(offsetMs)}</span>
                )}
            </div>
        </div>
    );

    // ── minimal ─────────────────────────────────────────────────────────────
    if (minimal) {
        return (
            <div className="ck ck--minimal">
                <div className="tp__bar">
                    <span className={`tp__status tp__status--${statusTone}`}>{statusLabel}</span>
                    <span className="ck__station">{stationLabel(station)}</span>
                    <span className="tp__bar-gap" />
                    {quality != null && (
                        <span className="ck__quality" title="How far the voter trusts this timestamp: the smallest winning margin across its bits, not the average">
                            {quality}%
                        </span>
                    )}
                    {transport}
                </div>
                {reading}
                {error && <div className="note note--warn ck__fault">{error}</div>}
            </div>
        );
    }

    // ── expanded ────────────────────────────────────────────────────────────
    const flags = frameFlags(frame);
    const frameDate = frame ? formatDate(frame.doy, frame.year2) : null;
    const dut1 = frame ? formatDut1(frame.dut1_tenths) : null;

    return (
        <div className="ck">
            <div className="tp__bar">
                <span
                    className={`tp__status tp__status--${statusTone}`}
                    title="Whether the decoder is attached on the server, and whether it has a lock"
                >
                    {statusLabel}
                </span>
                <span
                    className="ck__station"
                    title={station === 'unknown'
                        ? 'WWV and WWVH share one decoder and are told apart by which tick band folds to an impulse — that takes a few seconds of clean signal'
                        : 'Identified by the decoder from the seconds tick'}
                >
                    {stationLabel(station)}
                </span>
                <span className="tp__bar-gap" />

                <label className="tp__field tp__field--inline" title="Tune to a time-signal frequency. These are already offset 1 kHz below the carrier, which is how the decoder needs them">
                    <span className="tp__field-label">Tune</span>
                    <select
                        className="select"
                        value={tuned ? String(tuned.hz) : ''}
                        onChange={(e) => {
                            const hz = Number(e.target.value);
                            for (const g of CLOCK_FREQUENCIES) {
                                for (const o of g.options) if (o.hz === hz) tuneTo(o);
                            }
                        }}
                    >
                        {!tuned && <option value="">Tune to…</option>}
                        {CLOCK_FREQUENCIES.map((g) => (
                            <optgroup key={g.group} label={g.group}>
                                {g.options.map((o) => (
                                    <option key={o.hz} value={o.hz}>{o.label}</option>
                                ))}
                            </optgroup>
                        ))}
                    </select>
                </label>

                {transport}
            </div>

            {!running && <div className="note note--tight">Start the receiver to decode.</div>}
            {running && !live && <div className="note note--tight">Waiting for the audio connection…</div>}

            {wrongMode && (
                <div className="note note--warn ck__fix">
                    The time code is received in USB — 1 kHz below the carrier, which puts
                    the carrier itself at 1000 Hz of audio. Pick a frequency above.
                </div>
            )}
            {narrow && (
                <div className="note note--warn ck__fix">
                    The passband stops at {tuning.bandwidthHigh} Hz. WWV’s seconds tick is
                    recovered from its 2000 Hz image (2200 Hz for WWVH), so a filter this
                    narrow removes the one thing the decoder starts from — it will sit in
                    Acquiring for ever. Widen it to at least 2.4 kHz.
                </div>
            )}
            {/* 60 kHz is not WWVB's alone: MSF transmits from Anthorn on the
                same frequency, and in Europe it is the one you will hear. Its
                time code is a different format entirely, so the decoder gets a
                strong clean carrier it cannot read — the carrier stage of the
                funnel passes, everything after it never does, and nothing else
                on screen would explain why. */}
            {dialStation === 'wwvb' && (
                <div className="note note--tight">
                    60 kHz carries WWVB from Colorado and MSF from Anthorn in the UK. Only
                    WWVB is decoded here; on MSF the carrier is found and the time code
                    never resolves.
                </div>
            )}
            {live && !decoding && !wrongMode && !narrow && (
                <div className="note note--tight">
                    Press Start. A lock needs about four minutes of readable signal — two to
                    find the minute and two more before the vote will certify a time.
                </div>
            )}
            {error && <div className="note note--warn ck__fault">{error}</div>}
            {stale && (
                <div className="note note--warn ck__fault">
                    Nothing decoded for {Math.round((now - time.at) / 1000)} s — the reading
                    below is the last one, not the current time.
                </div>
            )}

            {reading}

            {decoding && (
                <>
                    <div className="ck__grid">
                        <Readout
                            label="Quality"
                            value={quality != null ? `${quality}%` : '—'}
                            tone={quality == null ? 'off' : (quality >= 50 ? 'good' : 'warn')}
                            reserve
                        />
                        <Readout
                            label="Browser clock"
                            value={formatOffset(browserOffset)}
                            tone={offsetTone(browserOffset)}
                            reserve
                        />
                        <Readout label="Date" value={frameDate || '—'} reserve />
                        <Readout
                            label="DUT1"
                            value={dut1 || '—'}
                            reserve
                        />
                    </div>

                    {flags.length > 0 && (
                        <div className="ck__flags">
                            {flags.map((f) => (
                                <span key={f.id} className={`ck__flag ck__flag--${f.tone}`}>{f.label}</span>
                            ))}
                        </div>
                    )}

                    <div className="ck__section">
                        <div className="ck__section-head">
                            <span className="ck__section-title">Second alignment</span>
                            <span className="ck__section-note">
                                the received envelope against the pulse it was matched to
                            </span>
                        </div>
                        <Alignment second={second} />
                    </div>

                    <div className="ck__section">
                        <div className="ck__section-head">
                            <span className="ck__section-title">Last minute</span>
                            <span className="ck__section-note">
                                markers fall on every tenth second once the frame is found
                            </span>
                        </div>
                        <Strip strip={strip} />
                    </div>

                    <div className="ck__section">
                        <div className="ck__section-head">
                            <span className="ck__section-title">Acquisition</span>
                            <span className="ck__section-note">each stage needs the one before it</span>
                        </div>
                        <Funnel diag={diag} station={station} />
                    </div>

                    {diag && (
                        <div className="ck__telemetry">
                            <span title="Folded tick-band peak-to-mean (WWV/WWVH), or the tone search peak over median (WWVB)">
                                tick {Number.isFinite(diag.tone_snr_db) ? `${diag.tone_snr_db.toFixed(1)} dB` : '—'}
                            </span>
                            <span title="The decoder's tracked matched-filter delay — the filter chain's own group delay plus any sample-clock drift it is absorbing">
                                delay {Number.isFinite(diag.delay_est_ms) ? `${diag.delay_est_ms.toFixed(1)} ms` : '—'}
                            </span>
                            <span title="Frames in the voter's sliding window">
                                window {diag.frames_in_window ?? '—'}/{diag.window_size ?? '—'}
                            </span>
                            <span title="The voter's own confidence in the current resolution, before the lock gates">
                                vote {Number.isFinite(diag.vote_quality) ? diag.vote_quality.toFixed(2) : '—'}
                            </span>
                            {frame && Number.isFinite(frame.confidence) && (
                                <span title="Mean per-second classification margin over this frame, before voting">
                                    frame {frame.confidence.toFixed(2)}
                                </span>
                            )}
                            {time && time.offset_source === 'packet' && (
                                <span title="The offset is measured against the arrival time of the audio packets on the receiver host, not against this browser's clock. It carries the receiver's own buffering as a fixed bias of some tens of milliseconds.">
                                    anchored on packet arrival
                                </span>
                            )}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
