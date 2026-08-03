import React, { useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import FrequencyDial from '../components/FrequencyDial.jsx';
import { Button, Field, Icon, Segmented, Slider } from '../components/ui.jsx';
import { MODES, MODE_BY_ID, TUNING_STEPS, bandwidthLimits, stepLabel } from '../radio/constants.js';

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
                <Segmented
                    columns={4}
                    size="sm"
                    value={tuning.mode}
                    onChange={actions.setMode}
                    options={MODES.map((m) => ({ value: m.id, label: m.label }))}
                />
            </Field>

            <Field label="Filter width" hint={`${width} Hz`}>
                <Slider
                    value={width}
                    min={100}
                    max={Math.abs(limits.max - limits.min)}
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

            {!running && <div className="note">Press <strong>Listen</strong> to start the receiver.</div>}
        </div>
    );
}
