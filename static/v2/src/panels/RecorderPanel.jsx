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
import {
    MAX_RECORDING_MS, formatElapsed, getRecorder, playbackDuration, wavSupported,
} from '../lib/recorder.js';

const FORMATS = [
    { value: 'webm', label: 'Opus', title: 'WebM/Opus — compressed, much smaller files' },
    { value: 'wav', label: 'WAV', title: 'Uncompressed 16-bit PCM — larger, no second encode' },
];

const DELIVERY = [
    {
        value: 'archive',
        label: 'Archive',
        title: 'A ZIP: the audio, what it was recorded on, and the signal log',
    },
    {
        value: 'audio',
        label: 'Audio only',
        title: 'The audio file on its own — nothing to unpack',
    },
];

// What Download will hand over, in words, from the two controls that decide it.
//
// Both halves are chosen on screen — the format buttons above and the toggle
// beside this — so the sentence follows them rather than describing one fixed
// arrangement that was right for whichever way they happened to be set.
function deliveryText(format, archive) {
    const name = format === 'wav' ? 'WAV' : 'Opus';
    const ext = format === 'wav' ? '.wav' : '.webm';
    return archive
        ? `The download is a ZIP holding the ${name} audio (${ext}), the frequency and mode it was`
            + ' made on, and a CSV of the signal readings taken once a second.'
        : `The download is the ${name} audio on its own (${ext}) — no metadata file and no signal`
            + ' log.';
}

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
    // Whole archive or bare audio. On the recorder for the same reason the
    // format is — a collapsed panel is unmounted and must not forget it.
    const [archive, setArchive] = useState(() => rec.preferArchive !== false);
    const [busyDownload, setBusyDownload] = useState(false);
    const [error, setError] = useState('');

    // Playback of the held recording. The element is the source of truth for
    // whether it is playing — its own events drive the flag, so pausing from
    // the OS media keys or the element ending on its own is reflected here.
    const audioRef = useRef(null);
    const [playing, setPlaying] = useState(false);
    // Where playback has reached, in seconds, and how long the recording is.
    //
    // The length is asked of the element and only falls back to the recorder's
    // own wall-clock figure when the element will not say: MediaRecorder writes
    // WebM with no duration in the header, so `el.duration` on an Opus
    // recording is Infinity until it has been seeked. That is exactly the case
    // a progress bar cannot survive, and elapsedMs is authoritative anyway —
    // it is the same number the clock has been showing all along.
    const [playPos, setPlayPos] = useState(0);
    const [playDur, setPlayDur] = useState(0);

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
        setPlayPos(0);
        setPlayDur(0);
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

    // Back to the start and silent. Pause on its own leaves the playhead where
    // it stopped, which is right for pausing and wrong for being finished with
    // it — without this there is no way back to the beginning.
    const stopPlayback = () => {
        const el = audioRef.current;
        if (!el) return;
        el.pause();                 // 'pause' unducks and clears the flag
        try { el.currentTime = 0; } catch (e) { /* nothing loaded */ }
        setPlayPos(0);
    };

    const download = async () => {
        setError('');
        setBusyDownload(true);
        try {
            await rec.save({ archive });
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

    const durationMs = playbackDuration(playDur, rec.elapsedMs);

    // Playback owns the clock and the bar whenever it is running or parked
    // part-way through. Both would otherwise sit frozen at the recording's
    // length while audio was plainly playing, which is what made the bar look
    // broken rather than merely idle.
    const scrubbing = playing || playPos > 0;

    // Which format the download text is about. The same rule the Format control
    // itself follows: once a recording is held, the buttons are locked to what
    // was actually captured, and a sentence describing the other one would be
    // describing a file that does not exist.
    const heldFormat = rec.busy ? rec.format : format;

    const status = recording ? 'recording' : playing ? 'playing' : rec.hasData ? 'ready' : 'idle';
    const statusLabel = {
        recording: 'RECORDING', playing: 'PLAYING', ready: 'READY', idle: 'STOPPED',
    }[status];

    return (
        <div className="stack">
            <div className="rec-status">
                <span className={`badge badge--${status === 'recording' ? 'rec' : status === 'idle' ? 'idle' : 'open'}`}>
                    {statusLabel}
                </span>
                <span className="rec-status__hint">
                    {recording
                        ? `${formatElapsed(MAX_RECORDING_MS - rec.elapsedMs)} left`
                        : scrubbing
                            ? `of ${formatElapsed(durationMs)}`
                            : rec.hasData
                                ? `${rec.format === 'wav' ? 'WAV' : 'Opus'} · ${rec.signal.length} signal samples`
                                : `${formatElapsed(MAX_RECORDING_MS)} maximum`}
                </span>
            </div>

            <div className={`rec-time${recording ? ' is-live' : ''}`}>
                {formatElapsed(scrubbing ? playPos * 1000 : rec.elapsedMs)}
            </div>

            {/* Two jobs, and which one it is doing is whether audio is playing.
                While recording it is the memory cap — everything is held until
                download, so that is not a detail to discover on the way past.
                While playing back it is the position in the recording, which is
                the only thing the bar can usefully mean once the recording has
                stopped growing. */}
            <Bar
                value={scrubbing
                    ? Math.min(playPos * 1000, durationMs)
                    : Math.min(rec.elapsedMs, MAX_RECORDING_MS)}
                max={scrubbing ? Math.max(durationMs, 1) : MAX_RECORDING_MS}
                color={recording ? 'var(--bad)' : scrubbing ? 'var(--accent)' : undefined}
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
                <div className="rec-actions">
                    <Button
                        icon={playing ? <Icon.Pause /> : <Icon.Play />}
                        title={playing
                            ? 'Pause, keeping your place'
                            : 'Play the recording back — the receiver is silenced while it plays'}
                        onClick={play}
                    >
                        {playing ? 'Pause' : 'Play'}
                    </Button>
                    {/* Disabled when playback is already at the start and not
                        running: there is nothing for it to do, and a live Stop
                        beside a paused-at-zero Play suggests otherwise. */}
                    <Button
                        icon={<Icon.Stop />}
                        disabled={!scrubbing}
                        title="Stop playback and go back to the start"
                        onClick={stopPlayback}
                    >
                        Stop
                    </Button>
                </div>
            )}

            {/* Hidden: the buttons above are the transport, and a second set of
                native controls would be two ways to do the same thing with only
                one of them ducking the receiver. */}
            <audio
                ref={audioRef}
                style={{ display: 'none' }}
                onPlay={() => { setPlaying(true); player.setDucked(true); }}
                onPause={() => { setPlaying(false); player.setDucked(false); }}
                onEnded={() => {
                    setPlaying(false);
                    player.setDucked(false);
                    // Back to the start, so the bar reads as "ready to play"
                    // rather than sitting full with nothing running.
                    setPlayPos(0);
                }}
                onTimeUpdate={(e) => setPlayPos(e.target.currentTime)}
                onLoadedMetadata={(e) => setPlayDur(e.target.duration)}
                onDurationChange={(e) => setPlayDur(e.target.duration)}
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
                    title={deliveryText(heldFormat, archive)}
                    onClick={download}
                >
                    {/* "Packaging" is the ZIP being built, which is a real wait
                        on a long WAV. There is none of it to do for the audio
                        on its own, and saying so would be a progress message
                        for a step that is not happening. */}
                    {busyDownload ? (archive ? 'Packaging…' : 'Saving…') : 'Download'}
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
                <>
                    {/* What the Download button will actually produce, next to
                        the sentence describing it — the choice and its
                        consequence in one place, rather than a switch up beside
                        the format buttons and an explanation down here. */}
                    <Field
                        label="Download"
                        hint={archive ? 'audio, metadata and signal log' : 'the audio file only'}
                    >
                        <Segmented
                            options={DELIVERY}
                            value={archive ? 'archive' : 'audio'}
                            onChange={(v) => {
                                const next = v === 'archive';
                                rec.preferArchive = next;
                                setArchive(next);
                            }}
                            size="sm"
                        />
                    </Field>
                    <div className="note note--tight">
                        Captures the processed audio as you hear it — filters, squelch
                        and the volume setting included. {deliveryText(heldFormat, archive)}
                    </div>
                </>
            )}
        </div>
    );
}
