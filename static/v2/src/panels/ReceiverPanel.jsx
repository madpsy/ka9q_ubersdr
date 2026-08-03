import React, { useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import FrequencyDial from '../components/FrequencyDial.jsx';
import { Button, Field, Icon, Segmented, Slider } from '../components/ui.jsx';
import {
    AGC_CONTROLS, MODES, MODE_BY_ID, TUNING_STEPS, bandwidthLimits, hasAGCSettings,
    maxFilterWidth, stepLabel,
} from '../radio/constants.js';

// AGC, shown only for USB and LSB — the only modes v1 exposes it for.
//
// Values are whatever the server reports: `agc_state` returns the operator's
// config.yaml `ssb_agc` defaults for anything this session has not overridden.
// Until that arrives the controls stay disabled rather than showing invented
// numbers, because `set_agc` pins an override that cannot be cleared.
function AGCSettings() {
    const { agc, actions, running } = useRadio();

    return (
        <>
            <div className="divider" />
            <div className="section-label">
                <span>AGC</span>
                {agc && (
                    <button type="button" className="chip chip--button" onClick={actions.resetAgc}>
                        Defaults
                    </button>
                )}
            </div>

            {!agc && (
                <div className="note note--tight">
                    {running ? 'Reading settings from the receiver…' : 'Start the receiver to load AGC settings.'}
                </div>
            )}

            {agc && AGC_CONTROLS.map((c) => (
                <Field key={c.id} label={c.label} hint={`${agc[c.id].toFixed(c.decimals)} ${c.unit}`}>
                    <Slider
                        value={agc[c.id]}
                        min={c.min}
                        max={c.max}
                        step={c.step}
                        onChange={(v) => actions.setAgcParams({ [c.id]: v })}
                    />
                </Field>
            ))}
        </>
    );
}

export default function ReceiverPanel() {
    const { tuning, actions, running } = useRadio();
    const [step, setStep] = useState(1000);

    const mode = MODE_BY_ID[tuning.mode] || MODES[0];
    const limits = bandwidthLimits(tuning.mode);
    const width = Math.abs(tuning.bandwidthHigh - tuning.bandwidthLow);

    // Lower-sideband modes are edited as a positive width around the carrier so
    // the sliders behave the same way regardless of sideband.
    const setWidth = (w) => {
        if (limits.sideband === 'lower') {
            actions.setBandwidth(tuning.bandwidthHigh - w, tuning.bandwidthHigh);
        } else if (limits.sideband === 'upper') {
            actions.setBandwidth(tuning.bandwidthLow, tuning.bandwidthLow + w);
        } else {
            actions.setBandwidth(-w / 2, w / 2);
        }
    };

    const setShift = (shift) => {
        if (limits.sideband === 'lower') {
            actions.setBandwidth(-width - shift, -shift);
        } else if (limits.sideband === 'upper') {
            actions.setBandwidth(shift, shift + width);
        } else {
            actions.setBandwidth(shift - width / 2, shift + width / 2);
        }
    };

    const shift = limits.sideband === 'lower'
        ? -tuning.bandwidthHigh
        : limits.sideband === 'upper'
            ? tuning.bandwidthLow
            : (tuning.bandwidthLow + tuning.bandwidthHigh) / 2;

    return (
        <div className="stack">
            <FrequencyDial frequency={tuning.frequency} onChange={actions.setFrequency} />

            <div className="tune-row">
                <Button variant="ghost" icon={<Icon.Minus />} title={`− ${stepLabel(step)}`} onClick={() => actions.nudge(-step)} />
                <select className="select" value={step} onChange={(e) => setStep(Number(e.target.value))}>
                    {TUNING_STEPS.map((s) => <option key={s} value={s}>{stepLabel(s)}</option>)}
                </select>
                <Button variant="ghost" icon={<Icon.Plus />} title={`+ ${stepLabel(step)}`} onClick={() => actions.nudge(step)} />
            </div>

            <Field label="Mode">
                {/* Wraps to as many rows as the dock width needs: 4x2 at the
                    default width, never fewer than 3 columns when narrowed. */}
                <Segmented
                    minItemWidth={54}
                    size="sm"
                    value={tuning.mode}
                    onChange={actions.setMode}
                    options={MODES.map((m) => ({ value: m.id, label: m.label }))}
                />
            </Field>

            <Field label="Filter width" hint={`${(width / 1000).toFixed(2)} kHz`}>
                <Slider
                    value={Math.min(width, maxFilterWidth(tuning.mode))}
                    min={100}
                    max={maxFilterWidth(tuning.mode)}
                    step={50}
                    onChange={setWidth}
                />
            </Field>

            <Field label="Filter shift" hint={`${Math.round(shift)} Hz`}>
                <Slider value={Math.round(shift)} min={-1500} max={1500} step={10} onChange={setShift} />
            </Field>

            <div className="passband">
                <span>{tuning.bandwidthLow} Hz</span>
                <span className="passband__mode">{mode.label}</span>
                <span>{tuning.bandwidthHigh} Hz</span>
            </div>

            {hasAGCSettings(tuning.mode) && <AGCSettings />}

            {!running && <div className="note">Press <strong>Listen</strong> to start the receiver.</div>}
        </div>
    );
}
