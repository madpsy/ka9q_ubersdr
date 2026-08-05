import React, { useEffect, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { useDisplay } from '../display/DisplayContext.jsx';
import FrequencyDial from '../components/FrequencyDial.jsx';
import { Button, Field, Icon, Segmented, Slider } from '../components/ui.jsx';
import { VFO_IDS, getVfos, onVfosChanged, selectVfo } from '../lib/vfos.js';
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

// Four VFOs under the dial. Each holds frequency, mode, passband and the
// spectrum zoom; the logic is in lib/vfos.js, this is the row of buttons.
//
// The VFOs themselves live in lib/vfos.js, not here: this panel is unmounted
// whenever it is collapsed or dragged to another dock, and the spectrum's
// right-click menu writes them too.
function VfoBar() {
    const radio = useRadio();
    const [vfos, setLocal] = useState(getVfos);

    useEffect(() => onVfosChanged(setLocal), []);

    // The switch itself is in lib/vfos.js, because a control mapped to "VFO B"
    // on a MIDI box or the FlexControl has to make exactly the same one.
    const select = (id) => selectVfo(radio, id);

    return (
        <div className="vfo-bar">
            {VFO_IDS.map((id) => {
                const s = vfos.slots[id];
                const on = vfos.active === id;
                return (
                    <button
                        key={id}
                        type="button"
                        className={`vfo-btn${on ? ' is-active' : ''}`}
                        aria-pressed={on}
                        title={on
                            ? `VFO ${id} — in use`
                            : s
                                ? `VFO ${id} — ${(s.frequency / 1e6).toFixed(3)} MHz ${s.mode.toUpperCase()}`
                                : `VFO ${id} — unused; takes a copy of the current settings`}
                        onClick={() => select(id)}
                    >
                        {id}
                    </button>
                );
            })}
        </div>
    );
}

// `minimal` keeps what you tune with — the dial, the VFOs, its step, the mode
// and the filter width — and drops the filter shift, the passband readout and
// AGC. See the registry's `minimal`.
export default function ReceiverPanel({ minimal }) {
    const { tuning, actions, running } = useRadio();
    // Shared with click-to-tune on the spectrum, so both land on the same grid.
    const display = useDisplay();
    const step = display.tuneStep || 500;
    const setStep = (hz) => display.set({ tuneStep: hz });

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

            <VfoBar />

            <div className="tune-row">
                <Button variant="ghost" icon={<Icon.Minus />} title={`− ${stepLabel(step)}`} onClick={() => actions.stepBy(step, -1)} />
                <select className="select" value={step} onChange={(e) => setStep(Number(e.target.value))}>
                    {TUNING_STEPS.map((s) => <option key={s} value={s}>{stepLabel(s)}</option>)}
                </select>
                <Button variant="ghost" icon={<Icon.Plus />} title={`+ ${stepLabel(step)}`} onClick={() => actions.stepBy(step, 1)} />
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

            {/* In the minimal view too. It is the one filter control you work
                at while listening — narrowing onto a signal next to a louder
                one is part of tuning, not part of setting the receiver up — and
                its own hint carries the width, so it needs neither the passband
                readout below nor a label of its own to be useful. */}
            <Field label="Filter width" hint={`${(width / 1000).toFixed(2)} kHz`}>
                <Slider
                    value={Math.min(width, maxFilterWidth(tuning.mode))}
                    min={100}
                    max={maxFilterWidth(tuning.mode)}
                    step={50}
                    onChange={setWidth}
                />
            </Field>

            {!minimal && (
                <>
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
                </>
            )}
        </div>
    );
}
