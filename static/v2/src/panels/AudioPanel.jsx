import React from '../react.js';
import { useMeters, useRadio } from '../radio/RadioContext.jsx';
import { Button, Field, Icon, Segmented, Slider } from '../components/ui.jsx';
import DspControl from './DspControl.jsx';
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
                        <Slider
                            value={Math.round(audio.volume * 100)}
                            min={0}
                            max={100}
                            onChange={(v) => actions.setVolume(v / 100)}
                        />
                        <span className="volume-row__value">{Math.round(audio.volume * 100)}</span>
                    </div>

                    <ChannelPicker />

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
