import React from '../react.js';
import { useMeters, useRadio } from '../radio/RadioContext.jsx';
import { Button, Field, Icon, Slider, Switch } from '../components/ui.jsx';
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
                    SNR {snr == null ? '--' : snr.toFixed(1)} dB
                </span>
                <button
                    type="button"
                    className="chip chip--button"
                    title="Set the threshold just under the current signal"
                    disabled={snr == null}
                    onClick={() => actions.setSquelch(
                        Math.max(SQUELCH_MIN + SQUELCH_STEP, Math.min(SQUELCH_MAX, Math.round((snr - 3) * 2) / 2)),
                    )}
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

export default function AudioPanel() {
    const { audio, actions, agc, dsp, serverInfo, running } = useRadio();
    const dspFilters = (serverInfo && serverInfo.dsp && serverInfo.dsp.filters) || [];
    const dspAvailable = !!(serverInfo && serverInfo.dsp && serverInfo.dsp.enabled) && dspFilters.length > 0;

    return (
        <div className="stack">
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
                A larger buffer rides out network jitter at the cost of latency.
            </div>

            <div className="divider" />

            <SquelchControl />
            <div className="note note--tight">
                Gates audio below the threshold, server-side. The marker shows
                live SNR — set the threshold just above the noise.
            </div>

            {dspAvailable && (
                <>
                    <div className="divider" />
                    <Field label="Noise reduction" hint={dsp.enabled ? dsp.filter : 'off'} inline>
                        <Switch
                            checked={dsp.enabled}
                            disabled={!running}
                            onChange={(on) => actions.setDsp(dsp.filter, on)}
                        />
                    </Field>
                    <div className="chip-row">
                        {dspFilters.map((f) => (
                            <button
                                key={f}
                                type="button"
                                className={`chip chip--button${dsp.filter === f ? ' is-active' : ''}`}
                                onClick={() => actions.setDsp(f, dsp.enabled)}
                            >
                                {f.toUpperCase()}
                            </button>
                        ))}
                    </div>
                </>
            )}

            {agc && (
                <>
                    <div className="divider" />
                    <Field label="AGC" inline>
                        <Switch
                            checked={agc.agcEnable !== false}
                            onChange={(on) => actions.setAgcParams({ agcEnable: on })}
                        />
                    </Field>
                    <Field label="Hang time" hint={`${Number(agc.agcHangTime ?? 1.1).toFixed(1)} s`}>
                        <Slider
                            value={Number(agc.agcHangTime ?? 1.1)}
                            min={0}
                            max={10}
                            step={0.1}
                            disabled={agc.agcEnable === false}
                            onChange={(v) => actions.setAgcParams({ agcHangTime: v })}
                        />
                    </Field>
                    <Field label="Recovery" hint={`${Math.round(agc.agcRecoveryRate ?? 20)} dB/s`}>
                        <Slider
                            value={Math.round(agc.agcRecoveryRate ?? 20)}
                            min={1}
                            max={100}
                            disabled={agc.agcEnable === false}
                            onChange={(v) => actions.setAgcParams({ agcRecoveryRate: v })}
                        />
                    </Field>
                    <Field label="Threshold" hint={`${Math.round(agc.agcThreshold ?? -15)} dB`}>
                        <Slider
                            value={Math.round(agc.agcThreshold ?? -15)}
                            min={-60}
                            max={0}
                            disabled={agc.agcEnable === false}
                            onChange={(v) => actions.setAgcParams({ agcThreshold: v })}
                        />
                    </Field>
                </>
            )}
        </div>
    );
}
