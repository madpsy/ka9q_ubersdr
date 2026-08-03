// Audio recorder — v1's recorder modal, as a dock panel.
//
// Same job and the same output: capture the processed audio, then hand over a
// ZIP holding the audio, a metadata text file and a per-second signal log.
// The machinery is in lib/recorder.js and lives outside React on purpose — a
// collapsed section is unmounted, and folding the panel away must not end a
// recording in progress. This file is the view over that object: it subscribes
// to its changes, ticks a clock while one is running, and nothing more.

import React, { useEffect, useReducer, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Bar, Button, Field, Icon, Segmented } from '../components/ui.jsx';
import { MAX_RECORDING_MS, formatElapsed, getRecorder, wavSupported } from '../lib/recorder.js';

const FORMATS = [
    { value: 'webm', label: 'Opus', title: 'WebM/Opus — compressed, much smaller files' },
    { value: 'wav', label: 'WAV', title: 'Uncompressed 16-bit PCM — larger, no second encode' },
];

export default function RecorderPanel() {
    const { player, running, tuning, serverInfo, meters } = useRadio();
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

    const recording = rec.state === 'recording';

    // Clock. Only while running, and only while this panel is on screen — the
    // cap itself is enforced by the recorder, not by this interval.
    useEffect(() => {
        if (!recording) return undefined;
        const t = setInterval(bump, 250);
        return () => clearInterval(t);
    }, [recording]);

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

            {recording ? (
                <Button variant="danger" icon={<Icon.Stop />} onClick={() => rec.stop()}>
                    Stop recording
                </Button>
            ) : (
                <Button variant="primary" icon={<Icon.Record />} disabled={!running} onClick={start}>
                    Start recording
                </Button>
            )}

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

            <div className="note note--tight">
                Captures the processed audio as you hear it — filters, squelch
                and the volume setting included. The download is a ZIP holding
                the audio, the frequency and mode it was made on, and a CSV of
                the signal readings taken once a second.
            </div>
        </div>
    );
}
