import React from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Button, Field, Icon, Slider, Switch } from '../components/ui.jsx';

export default function AudioPanel() {
    const { audio, actions, squelch, agc, dsp, serverInfo, running } = useRadio();
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

            <Field label="Squelch" hint={squelch.enabled ? `${squelch.threshold} dB SNR` : 'open'} inline>
                <Switch
                    checked={squelch.enabled}
                    onChange={(on) => actions.setSquelch(on, squelch.threshold)}
                />
            </Field>
            <Slider
                value={squelch.threshold}
                min={-10}
                max={40}
                disabled={!squelch.enabled}
                onChange={(v) => actions.setSquelch(squelch.enabled, v)}
            />

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
