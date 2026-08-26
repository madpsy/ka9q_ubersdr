import React, { useCallback, useEffect, useMemo, useRef, useState } from '../react.js';
import { useMeters, useRadio } from '../radio/RadioContext.jsx';
import { Button, Field, Icon, Modal, Readout, Segmented, Slider } from '../components/ui.jsx';
import { isIQ } from '../radio/constants.js';
import {
    listOutputDevices, micPermission, sinkLabel, sinkSupport, unlockDeviceLabels,
} from '../lib/audioSinks.js';

const CHANNELS = [
    { value: 'both', label: 'Both' },
    { value: 'left', label: 'Left' },
    { value: 'right', label: 'Right' },
];

// The same routing, named for what the sides actually carry in IQ.
const IQ_CHANNELS = [
    { value: 'both', label: 'I+Q', title: 'Both halves of the quadrature pair' },
    { value: 'left', label: 'I', title: 'In-phase only — silences Q' },
    { value: 'right', label: 'Q', title: 'Quadrature only — silences I' },
];

const FORMATS = [
    { value: 'opus', label: 'Opus', title: 'Compressed — the default, and around 50 kbit/s in every mode' },
    { value: 'pcm-zstd', label: 'Uncompressed', title: 'Lossless 16-bit PCM — 210 kbit/s on SSB and CW, 400 kbit/s on AM, SAM and FM' },
];

// Which audio format the stream is asked for, as the Python and Go clients
// offer. Opus unless the operator says otherwise, and saying otherwise goes
// through the same warning those clients show: the cost of the choice lands on
// whoever runs the receiver, not on the person making it, so it is put in front
// of them rather than left to be discovered.
//
// Only the expensive direction asks. Going back to Opus costs nothing and
// stopping to confirm it would be a dialog in the way of the right answer.
function FormatPicker() {
    const { audio, actions, tuning } = useRadio();
    const [confirming, setConfirming] = useState(false);
    const saved = audio.format || 'opus';
    // IQ is always uncompressed, so the control shows that and stops taking
    // input — but `audio.format` is deliberately *not* written. It is the
    // operator's standing preference, and the server restores it by itself the
    // moment the mode is no longer IQ (websocket.go keeps the format the socket
    // connected with and only overrides it per packet). Writing it here would
    // save uncompressed over the top and leave them on it in every mode
    // afterwards, having never chosen it.
    const iq = isIQ(tuning.mode);
    const current = iq ? 'pcm-zstd' : saved;

    const choose = (value) => {
        if (iq || value === current) return;
        if (value === 'pcm-zstd') {
            setConfirming(true);
            return;
        }
        actions.setAudioFormat(value);
    };

    const accept = () => {
        setConfirming(false);
        actions.setAudioFormat('pcm-zstd');
    };

    return (
        <>
            <Field label="Format" inline>
                {/* Both options are shown in IQ, not just the forced one: which
                    of the two is unavailable is the information, and dropping
                    Opus would read as the receiver not offering it at all. */}
                <Segmented
                    options={iq ? FORMATS.map((f) => ({ ...f, disabled: true })) : FORMATS}
                    value={current}
                    onChange={choose}
                    size="sm"
                />
            </Field>
            <div className="note note--tight">
                {iq ? (
                    <>
                        IQ is always uncompressed: Opus is a mono voice codec and
                        cannot carry a stereo I/Q pair. Your usual choice
                        (<strong>{saved === 'pcm-zstd' ? 'uncompressed' : 'Opus'}</strong>)
                        comes back when you leave IQ.
                    </>
                ) : (
                    <>
                        Opus is compressed; uncompressed sends lossless 16-bit PCM at
                        four to eight times the bandwidth, depending on the mode.
                        Changing this reconnects the audio stream.
                    </>
                )}
            </div>
            {confirming && (
                <Modal onClose={() => setConfirming(false)} label="High bandwidth warning">
                    <div className="stack vibe">
                        <h2 className="vibe__title">High bandwidth warning</h2>
                        {/* The Go and Python clients say 4×, which is the SSB
                            figure. This interface offers the AM family too, and
                            those run at 24 kHz where it is nearer 8×, so both
                            are given rather than the flattering one. */}
                        <p className="vibe__text">
                            Uncompressed audio uses approximately 4&times; more bandwidth
                            than Opus on SSB and CW, and around 8&times; on AM, SAM and FM.
                        </p>
                        <p className="vibe__text">
                            This increases costs for the instance owner. Only switch if you
                            have a specific reason to do so.
                        </p>
                        <div className="vibe__row">
                            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                                Cancel
                            </Button>
                            <Button size="sm" variant="primary" onClick={accept}>
                                Use uncompressed
                            </Button>
                        </div>
                    </div>
                </Modal>
            )}
        </>
    );
}

// Which output side to listen on, as in v1's Left/Right checkboxes. This is
// output routing, not a stereo decode: in every mode but IQ the two channels
// are one mono stream duplicated, so picking a side only changes which ear it
// arrives in.
//
// IQ is the one mode where the sides are genuinely different signals — left is
// I and right is Q — so they are named for what they are. Choosing one is then
// a real choice with a real consequence (it silences the other half of the
// quadrature pair) rather than a seating preference, which is worth saying in
// the label rather than leaving to be discovered.
function ChannelPicker() {
    const { audio, actions, tuning } = useRadio();
    const iq = isIQ(tuning.mode);
    return (
        <Field label="Channel" inline>
            <Segmented
                options={iq ? IQ_CHANNELS : CHANNELS}
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

// `minimal` keeps the volume and the channel — how loud, and out of which ear —
// and drops the output device, the buffer and the stream format, which are set
// once a session and not while listening.
//
// It used to keep noise reduction and drop all three of those, because noise
// reduction was in this panel and was the only thing in it worth riding. That
// is now its own panel (NoisePanel), so the cut-down view here is the two
// controls somebody actually reaches for mid-session.
//
// Squelch used to live here and is now in the Signal panel, beside the SNR
// meter it is a threshold on: the number you set it against is drawn there, and
// having the two in different panels meant watching one while dragging the
// other. See SquelchControl there.
// What the stream actually is, as opposed to what was asked for.
//
// Two rates, because they are two different facts and can disagree. The stream
// rate is what the server is sending; the context rate is what the browser
// agreed to play at. _createContext asks for the former and silently falls back
// to the device default if it is refused — at which point everything is being
// resampled, which matters most in exactly the mode where it is most likely
// (IQ asks for 12 kHz, an unusual rate to be granted). So the second is shown
// only when it differs, where it is the answer to a real question.
export function StreamFormat() {
    const m = useMeters(4);
    const rate = m.streamRate;
    const ch = m.channels;
    if (!rate && !ch) return null;

    const resampled = rate && m.contextRate && m.contextRate !== rate;
    return (
        <>
            <div className="readout-grid">
                <Readout
                    label="Sample rate"
                    value={rate ? (rate / 1000).toFixed(rate % 1000 ? 1 : 0) : '—'}
                    unit="kHz"
                />
                <Readout
                    label="Channels"
                    value={ch || '—'}
                    unit={ch === 2 ? 'stereo' : ch === 1 ? 'mono' : ''}
                />
            </div>
            {resampled && (
                <div className="note note--tight">
                    Playing at {(m.contextRate / 1000).toFixed(1)} kHz — this browser
                    refused the stream&rsquo;s own rate, so the audio is being resampled.
                </div>
            )}
        </>
    );
}

export default function AudioPanel({ minimal }) {
    const { audio, actions } = useRadio();

    return (
        <div className="stack">
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

            {!minimal && (
                <>
                    <StreamFormat />

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

                    <FormatPicker />
                </>
            )}
        </div>
    );
}
