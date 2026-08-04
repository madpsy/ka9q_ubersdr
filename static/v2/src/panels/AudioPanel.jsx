import React, { useCallback, useEffect, useMemo, useRef, useState } from '../react.js';
import { useMeters, useRadio } from '../radio/RadioContext.jsx';
import { Button, Field, Icon, Segmented, Slider } from '../components/ui.jsx';
import DspControl from './DspControl.jsx';
import { listOutputDevices, sinkLabel, sinkSupport, unlockDeviceLabels } from '../lib/audioSinks.js';
import { SQUELCH_MAX, SQUELCH_MIN, SQUELCH_STEP } from '../radio/constants.js';

// Split out so the 12 Hz meter sampling that drives the live SNR marker and the
// open/closed badge re-renders only this control, not the whole panel.
function SquelchControl() {
    const { squelch, actions } = useRadio();
    const m = useMeters(12);
    const snr = m.snr;
    const open = m.squelchOpen;

    return (
        <>
            <Field
                label="Squelch"
                hint={squelch.enabled ? `≥ ${squelch.value.toFixed(1)} dB SNR` : 'Off'}
            >
                <Slider
                    value={squelch.value}
                    min={SQUELCH_MIN}
                    max={SQUELCH_MAX}
                    step={SQUELCH_STEP}
                    onChange={actions.setSquelch}
                    marker={snr == null ? null : snr}
                    markerTone={squelch.enabled && !open ? 'closed' : 'open'}
                    markerTitle={snr == null ? undefined : `Current SNR: ${snr.toFixed(1)} dB`}
                />
            </Field>
            <div className="squelch-status">
                <span className={`badge badge--${!squelch.enabled ? 'idle' : open ? 'open' : 'closed'}`}>
                    {!squelch.enabled ? 'DISABLED' : open ? 'OPEN' : 'CLOSED'}
                </span>
                <span className="squelch-status__snr">
                    SNR {snr == null ? '--' : snr.toFixed(1)}
                </span>
                <button
                    type="button"
                    className="chip chip--button"
                    title="Set the threshold just above the recent noise level"
                    disabled={snr == null}
                    onClick={actions.autoSquelch}
                >
                    Auto
                </button>
                {squelch.enabled && (
                    <button type="button" className="chip chip--button" onClick={() => actions.setSquelch(SQUELCH_MIN)}>
                        Off
                    </button>
                )}
            </div>
        </>
    );
}

const CHANNELS = [
    { value: 'both', label: 'Both' },
    { value: 'left', label: 'Left' },
    { value: 'right', label: 'Right' },
];

// Which output side to listen on, as in v1's Left/Right checkboxes. This is
// output routing, not a stereo decode: every buffer is scheduled with two
// channels (a mono stream duplicated), so it works in every mode.
function ChannelPicker() {
    const { audio, actions } = useRadio();
    return (
        <Field label="Channel" inline>
            <Segmented
                options={CHANNELS}
                value={audio.channel || 'both'}
                onChange={actions.setChannel}
                size="sm"
            />
        </Field>
    );
}

// Which device the audio comes out of — v1's "Output Device" selector.
//
// The list is read on mount but the names are *not* unlocked on mount: browsers
// only reveal them once microphone permission is granted, and a panel that
// throws a mic prompt at you for opening it is not one you want to open. So the
// prompt is a button, and until it is pressed the devices are still selectable,
// just anonymously.
function OutputDevicePicker() {
    const { audio, actions } = useRadio();
    const support = useMemo(sinkSupport, []);
    const [devices, setDevices] = useState([]);
    const [hidden, setHidden] = useState(false);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const alive = useRef(true);

    const refresh = useCallback(async () => {
        try {
            const { devices: found, hidden: anon } = await listOutputDevices();
            if (!alive.current) return;
            setDevices(found);
            setHidden(anon);
            setError('');
        } catch (err) {
            if (alive.current) setError(err.message || 'could not list devices');
        }
    }, []);

    useEffect(() => {
        alive.current = true;
        if (!support.supported) return undefined;
        refresh();
        // Plugging in a headset should not need the panel reopening.
        const md = navigator.mediaDevices;
        md.addEventListener('devicechange', refresh);
        return () => {
            alive.current = false;
            md.removeEventListener('devicechange', refresh);
        };
    }, [support.supported, refresh]);

    if (!support.supported) {
        return (
            <>
                <Field label="Output">
                    <select className="select" disabled value="">
                        <option value="">System Default</option>
                    </select>
                </Field>
                <div className="note note--tight">{support.reason}</div>
            </>
        );
    }

    const unlock = async () => {
        setBusy(true);
        try {
            await unlockDeviceLabels();
            await refresh();
        } catch (err) {
            if (alive.current) setError('Microphone permission denied — device names stay hidden.');
        } finally {
            if (alive.current) setBusy(false);
        }
    };

    const choose = async (id) => {
        setBusy(true);
        setError('');
        try {
            await actions.setAudioSink(id);
        } catch (err) {
            if (alive.current) setError(`Could not use that device: ${err.message || err.name}`);
        } finally {
            if (alive.current) setBusy(false);
        }
    };

    // A saved device that is not in the list — unplugged since, or its names
    // are still hidden — would otherwise make the select fall back to showing
    // "System Default" while the player is still pointed at it.
    const known = devices.some((d) => d.deviceId === audio.sinkId);

    return (
        <>
            <Field label="Output">
                <select
                    className="select"
                    value={audio.sinkId}
                    disabled={busy}
                    onChange={(e) => choose(e.target.value)}
                >
                    <option value="">System Default</option>
                    {devices
                        .filter((d) => d.deviceId && d.deviceId !== 'default')
                        .map((d) => (
                            <option key={d.deviceId} value={d.deviceId}>{sinkLabel(d)}</option>
                        ))}
                    {audio.sinkId && !known && (
                        <option value={audio.sinkId}>Saved device …{audio.sinkId.slice(-6)}</option>
                    )}
                </select>
            </Field>
            <div className="chip-row chip-row--wrap">
                <button type="button" className="chip chip--button" onClick={refresh} disabled={busy}>
                    Refresh
                </button>
                {hidden && (
                    <button type="button" className="chip chip--button" onClick={unlock} disabled={busy}>
                        Show device names
                    </button>
                )}
            </div>
            {error
                ? <div className="note note--tight note--warn">{error}</div>
                : hidden && (
                    <div className="note note--tight">
                        Device names are hidden until you grant microphone permission —
                        the browser ties the two together. Nothing is recorded.
                    </div>
                )}
        </>
    );
}

// `minimal` keeps squelch and noise reduction — the two you ride while
// listening — and drops volume, channel and buffer, which are set once. The
// squelch explainer goes with them: it describes a control you already know how
// to use by the time you are running minimal. See the registry's `minimal`.
export default function AudioPanel({ minimal }) {
    const { audio, actions } = useRadio();

    return (
        <div className="stack">
            {!minimal && (
                <>
                    <div className="volume-row">
                        <Button
                            variant="ghost"
                            icon={audio.muted ? <Icon.Mute /> : <Icon.Volume />}
                            title={audio.muted ? 'Unmute' : 'Mute'}
                            active={audio.muted}
                            onClick={actions.toggleMute}
                        />
                        {/* Disabled, not hidden — see the top bar. */}
                        <Slider
                            value={Math.round(audio.volume * 100)}
                            min={0}
                            max={100}
                            disabled={audio.muted}
                            onChange={(v) => actions.setVolume(v / 100)}
                        />
                        <span className={`volume-row__value${audio.muted ? ' is-muted' : ''}`}>
                            {Math.round(audio.volume * 100)}
                        </span>
                    </div>

                    <ChannelPicker />
                    <OutputDevicePicker />

                    <Field label="Buffer" hint={`${Math.round(audio.bufferSec * 1000)} ms`}>
                        <Slider
                            value={Math.round(audio.bufferSec * 1000)}
                            min={60}
                            max={800}
                            step={20}
                            onChange={(ms) => actions.setBufferSec(ms / 1000)}
                        />
                    </Field>
                    <div className="note note--tight">
                        The most delay allowed before audio is dropped to catch up.
                        A larger buffer rides out network jitter at the cost of latency.
                    </div>

                    <div className="divider" />
                </>
            )}

            <SquelchControl />
            {!minimal && (
                <div className="note note--tight">
                    Gates audio below the threshold, server-side. The marker shows
                    live SNR — set the threshold just above the noise.
                </div>
            )}

            <DspControl />

        </div>
    );
}
