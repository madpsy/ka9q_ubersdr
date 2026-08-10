// Audio recorder — v1's recorder modal, as a dock panel.
//
// Same job and the same output: capture the processed audio, then hand over a
// ZIP holding the audio, a metadata text file and a per-second signal log.
// The machinery is in lib/recorder.js and lives outside React on purpose — a
// collapsed section is unmounted, and folding the panel away must not end a
// recording in progress. This file is the view over that object: it subscribes
// to its changes, ticks a clock while one is running, and nothing more.

import React, { useEffect, useReducer, useRef, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Bar, Button, Field, Icon, Segmented } from '../components/ui.jsx';
import { MAX_RECORDING_MS, formatElapsed, getRecorder, wavSupported } from '../lib/recorder.js';

const FORMATS = [
    { value: 'webm', label: 'Opus', title: 'WebM/Opus — compressed, much smaller files' },
    { value: 'wav', label: 'WAV', title: 'Uncompressed 16-bit PCM — larger, no second encode' },
];

// `minimal` drops the format picker and the explainer, leaving the status, the
// clock and the buttons. The format still applies — whatever was last chosen is
// what the next recording uses. See the registry's `minimal`.
export default function RecorderPanel({ minimal }) {
    const { audio, player, running, tuning, serverInfo, meters } = useRadio();
    const rec = getRecorder(player);

    // The recorder is not React state, so a change on it has to be turned into
    // a render by hand.
    const [, bump] = useReducer((n) => n + 1, 0);
    useEffect(() => rec.on('change', bump), [rec]);

    // Format for the *next* recording. Once one exists the control is locked to
    // what was actually captured, so the buttons cannot promise a file that is
    // not there. The choice itself is kept on the recorder, which outlives this
    // component being unmounted by a collapse.
    const [format, setFormat] = useState(() => rec.preferredFormat);
    const [busyDownload, setBusyDownload] = useState(false);
    const [error, setError] = useState('');

    // Playback of the held recording. The element is the source of truth for
    // whether it is playing — its own events drive the flag, so pausing from
    // the OS media keys or the element ending on its own is reflected here.
    const audioRef = useRef(null);
    const [playing, setPlaying] = useState(false);

    const recording = rec.state === 'recording';

    // Clock. Only while running, and only while this panel is on screen — the
    // cap itself is enforced by the recorder, not by this interval.
    useEffect(() => {
        if (!recording) return undefined;
        const t = setInterval(bump, 250);
        return () => clearInterval(t);
    }, [recording]);

    // Playback must not outlive the panel. A collapsed section is unmounted,
    // and a recording still playing into a ducked receiver with no button left
    // to stop it is the one way this can strand the audio.
    useEffect(() => () => {
        const el = audioRef.current;
        if (el) el.pause();
        player.setDucked(false);
    }, [player]);

    // Clear, or starting the next recording, takes the URL out from under the
    // element — the recorder revokes it. Drop the source rather than leaving
    // the element pointed at a revoked blob, which fails on the next press.
    const held = rec.hasData;
    useEffect(() => {
        if (held) return;
        const el = audioRef.current;
        if (!el) return;
        el.pause();
        el.removeAttribute('src');
        el.load();
    }, [held]);

    const wavOk = wavSupported();
    const options = FORMATS.map((f) => (
        f.value === 'wav' && !wavOk
            ? { ...f, label: 'WAV', title: 'WAV recording needs a secure context (HTTPS)' }
            : f
    ));

    const start = async () => {
        setError('');
        try {
            await rec.start({
                format,
                meta: {
                    frequency: tuning.frequency,
                    mode: tuning.mode,
                    bandwidthLow: tuning.bandwidthLow,
                    bandwidthHigh: tuning.bandwidthHigh,
                    receiver: (serverInfo && serverInfo.receiver) || null,
                },
                sample: () => meters.current,
            });
        } catch (err) {
            setError(err.message || String(err));
        }
    };

    // Playback of what was just captured, so it can be checked before it is
    // downloaded — or instead of downloading it at all.
    //
    // The live receiver is ducked while it plays. Two streams of the same
    // frequency a few seconds apart is not a comparison, it is a mess, and this
    // is the same mechanism the Whisper and FreeDV extensions use for the same
    // reason. player.setDucked rather than actions.setDucked deliberately: the
    // action's flag makes the top bar say "silenced while the radio is
    // transmitting", which would be a lie here.
    const play = async () => {
        const el = audioRef.current;
        if (!el) return;
        if (!el.paused) {
            el.pause();     // 'pause' unducks and clears the flag
            return;
        }
        setError('');
        try {
            const url = await rec.previewUrl();
            if (!url) return;
            if (el.src !== url) {
                el.src = url;
                // A held recording is played from its start, not from wherever
                // the last listen was paused — this is a check of a capture,
                // and the interesting part is usually the beginning.
                el.currentTime = 0;
            }
            // Whatever output device the operator picked for the receiver. Not
            // supported everywhere, and a failure only means it plays out of
            // the default one, so it must not stop playback.
            if (audio.sinkId && typeof el.setSinkId === 'function') {
                try { await el.setSinkId(audio.sinkId); } catch (e) { /* default output */ }
            }
            await el.play();
        } catch (err) {
            setError(err.message || String(err));
        }
    };

    const download = async () => {
        setError('');
        setBusyDownload(true);
        try {
            await rec.save();
        } catch (err) {
            setError(err.message || String(err));
        } finally {
            setBusyDownload(false);
        }
    };

    const clear = () => {
        if (recording && !window.confirm('Stop and discard the current recording?')) return;
        setError('');
        rec.clear();
    };

    const status = recording ? 'recording' : rec.hasData ? 'ready' : 'idle';
    const statusLabel = { recording: 'RECORDING', ready: 'READY', idle: 'STOPPED' }[status];

    return (
        <div className="stack">
            <div className="rec-status">
                <span className={`badge badge--${status === 'recording' ? 'rec' : status === 'ready' ? 'open' : 'idle'}`}>
                    {statusLabel}
                </span>
                <span className="rec-status__hint">
                    {recording
                        ? `${formatElapsed(MAX_RECORDING_MS - rec.elapsedMs)} left`
                        : rec.hasData
                            ? `${rec.format === 'wav' ? 'WAV' : 'Opus'} · ${rec.signal.length} signal samples`
                            : `${formatElapsed(MAX_RECORDING_MS)} maximum`}
                </span>
            </div>

            <div className={`rec-time${recording ? ' is-live' : ''}`}>{formatElapsed(rec.elapsedMs)}</div>

            {/* Everything is held in memory until download, so the cap is not a
                detail to discover on the way past — the bar makes it visible. */}
            <Bar
                value={Math.min(rec.elapsedMs, MAX_RECORDING_MS)}
                max={MAX_RECORDING_MS}
                color={recording ? 'var(--bad)' : undefined}
            />

            {!minimal && (
                <Field label="Format" hint={rec.busy ? 'locked while a recording is held' : undefined}>
                    <Segmented
                        options={options}
                        value={rec.busy ? rec.format : format}
                        onChange={(v) => {
                            if (rec.busy) return;
                            if (v === 'wav' && !wavOk) {
                                setError('WAV recording needs a secure context (HTTPS).');
                                return;
                            }
                            setError('');
                            rec.preferredFormat = v;
                            setFormat(v);
                        }}
                        size="sm"
                    />
                </Field>
            )}

            {recording ? (
                <Button variant="danger" icon={<Icon.Stop />} onClick={() => rec.stop()}>
                    Stop recording
                </Button>
            ) : (
                <Button variant="primary" icon={<Icon.Record />} disabled={!running} onClick={start}>
                    Start recording
                </Button>
            )}

            {/* Under the transport button rather than beside Download and
                Clear: it is the other thing you *do* with a recording, where
                those two are what you do with the file. Full width for the same
                reason, and only here at all once there is something to play —
                the row below keeps its two columns either way. */}
            {rec.hasData && !recording && (
                <Button
                    icon={playing ? <Icon.Pause /> : <Icon.Play />}
                    title={playing
                        ? 'Pause playback'
                        : 'Play the recording back — the receiver is silenced while it plays'}
                    onClick={play}
                >
                    {playing ? 'Pause' : 'Play recording'}
                </Button>
            )}

            {/* Hidden: the buttons above are the transport, and a second set of
                native controls would be two ways to do the same thing with only
                one of them ducking the receiver. */}
            <audio
                ref={audioRef}
                style={{ display: 'none' }}
                onPlay={() => { setPlaying(true); player.setDucked(true); }}
                onPause={() => { setPlaying(false); player.setDucked(false); }}
                onEnded={() => { setPlaying(false); player.setDucked(false); }}
                onError={() => {
                    setPlaying(false);
                    player.setDucked(false);
                    // Clearing the recording drops the source, and an element
                    // whose src has just been taken away reports that as an
                    // error too. Only a source that is still there can have
                    // genuinely failed to play.
                    if (audioRef.current && audioRef.current.getAttribute('src')) {
                        setError('That recording could not be played back.');
                    }
                }}
            />

            <div className="rec-actions">
                <Button
                    icon={<Icon.Download />}
                    size="sm"
                    disabled={!rec.hasData || recording || busyDownload}
                    onClick={download}
                >
                    {busyDownload ? 'Packaging…' : 'Download'}
                </Button>
                <Button
                    icon={<Icon.Trash />}
                    size="sm"
                    disabled={!rec.busy}
                    onClick={clear}
                >
                    Clear
                </Button>
            </div>

            {error && <div className="note note--warn">{error}</div>}
            {!error && rec.notice && <div className="note note--warn">{rec.notice}</div>}

            {!running && !rec.hasData && (
                <div className="note note--tight">Start the receiver to record.</div>
            )}

            {!minimal && (
                <div className="note note--tight">
                    Captures the processed audio as you hear it — filters, squelch
                    and the volume setting included. The download is a ZIP holding
                    the audio, the frequency and mode it was made on, and a CSV of
                    the signal readings taken once a second.
                </div>
            )}
        </div>
    );
}
