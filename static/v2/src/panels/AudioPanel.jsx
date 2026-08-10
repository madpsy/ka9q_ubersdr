import React, { useCallback, useEffect, useMemo, useRef, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Button, Field, Icon, Segmented, Slider } from '../components/ui.jsx';
import DspControl from './DspControl.jsx';
import {
    listOutputDevices, micPermission, sinkLabel, sinkSupport, unlockDeviceLabels,
} from '../lib/audioSinks.js';

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
// Reading the list and revealing the names are two different things: browsers
// treat device labels as fingerprinting surface and only hand them over once
// microphone permission is granted. So the list is read on mount, quietly, and
// the permission is asked for only when the operator presses Refresh — a panel
// that can sit open all session should not throw a mic prompt at you for being
// opened, which is what v1's settings modal effectively does.
function OutputDevicePicker() {
    const { audio, actions } = useRadio();
    const support = useMemo(sinkSupport, []);
    const [devices, setDevices] = useState([]);
    const [hidden, setHidden] = useState(false);
    // Whether the microphone has already been asked about — only to tell "nobody
    // has been asked" apart from "asked, granted, and there is still nothing to
    // list", which look the same from here and want opposite advice.
    const [perm, setPerm] = useState(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const alive = useRef(true);

    // `unlock` is what separates the button from the mount and the devicechange
    // event: those re-read silently, the button may also ask for the mic. It
    // asks only when there is something to gain — names that are still hidden
    // after the list has been re-read.
    const refresh = useCallback(async (unlock) => {
        try {
            let { devices: found, hidden: anon } = await listOutputDevices();
            if (!alive.current) return;
            micPermission().then((state) => { if (alive.current) setPerm(state); });
            if (anon && unlock) {
                setBusy(true);
                try {
                    await unlockDeviceLabels();
                    if (!alive.current) return;
                    ({ devices: found, hidden: anon } = await listOutputDevices());
                } catch (permErr) {
                    // Denied, or dismissed. The re-read above still stands, so
                    // keep it and say why the names are missing.
                    if (!alive.current) return;
                    setDevices(found);
                    setHidden(anon);
                    setError('Microphone permission denied — device names stay hidden.');
                    return;
                } finally {
                    if (alive.current) setBusy(false);
                }
                if (!alive.current) return;
            }
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
        const reread = () => refresh(false);
        reread();
        // Plugging in a headset should not need the panel reopening.
        const md = navigator.mediaDevices;
        md.addEventListener('devicechange', reread);
        return () => {
            alive.current = false;
            md.removeEventListener('devicechange', reread);
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
                <button
                    type="button"
                    className="chip chip--button"
                    title={hidden
                        ? 'Re-scan for devices, and ask for microphone permission to show their names'
                        : 'Re-scan for devices'}
                    onClick={() => refresh(true)}
                    disabled={busy}
                >
                    Refresh
                </button>
            </div>
            {error
                ? <div className="note note--tight note--warn">{error}</div>
                : hidden && (
                    <div className="note note--tight">
                        {perm === 'granted'
                            /* Permission is in hand and the browser still names
                               nothing: this machine has one output and the system
                               default is it. Repeating the advice to press Refresh
                               would send the operator round the same loop. */
                            ? 'This browser reports no output devices besides the system default.'
                            : 'The browser hides device names until microphone permission is granted — Refresh asks for it. Nothing is recorded.'}
                    </div>
                )}
        </>
    );
}

// `minimal` keeps noise reduction — the one thing here you ride while
// listening — and drops volume, channel and buffer, which are set once.
//
// Squelch used to live here and is now in the Signal panel, beside the SNR
// meter it is a threshold on: the number you set it against is drawn there, and
// having the two in different panels meant watching one while dragging the
// other. See SquelchControl there.
export default function AudioPanel({ minimal }) {
    const { audio, actions } = useRadio();

    return (
        <div className="stack">
            {!minimal && (
                <>
                    {/* `ducked` is not `muted`, and the difference is the whole
                        point of it: something else — a transmitting rig, an
                        extension speaking — has silenced the audio for a moment
                        without touching the setting the button shows. Saying so
                        here is what stops "the audio stopped and the volume
                        control looks fine" from reading as a broken receiver. */}
                    <div className={`volume-row${audio.ducked ? ' is-ducked' : ''}`}>
                        <Button
                            variant="ghost"
                            icon={audio.muted || audio.ducked ? <Icon.Mute /> : <Icon.Volume />}
                            title={audio.ducked
                                ? 'Silenced while the radio is transmitting — your mute is unchanged'
                                : (audio.muted ? 'Unmute' : 'Mute')}
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
                        <span className={`volume-row__value${audio.muted || audio.ducked ? ' is-muted' : ''}`}>
                            {Math.round(audio.volume * 100)}
                        </span>
                    </div>
                    {audio.ducked && !audio.muted && (
                        <div className="note note--tight">
                            Silenced while the radio transmits. Your mute and volume are untouched.
                        </div>
                    )}

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

            <DspControl />

        </div>
    );
}
