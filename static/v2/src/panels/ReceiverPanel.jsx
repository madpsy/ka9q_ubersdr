import React, { useEffect, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { useDisplay } from '../display/DisplayContext.jsx';
import FrequencyDial from '../components/FrequencyDial.jsx';
import FilterReset from '../components/FilterReset.jsx';
import { Button, Field, Icon, Segmented, Slider } from '../components/ui.jsx';
import { VFO_IDS, getVfos, onVfosChanged, selectVfo } from '../lib/vfos.js';
import {
    AGC_CONTROLS, FILTER_WIDTH_MIN, FILTER_WIDTH_STEP, MODES, MODE_BY_ID, TUNING_STEPS,
    edgesForShift, edgesForWidth, filterShift, hasAGCSettings, isIQ,
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

// `minimal` keeps what you tune with — the dial, its step and the mode — and
// drops the filter controls, the passband readout, AGC and the VFO buttons. The
// filter is reachable from the spectrum in any case: drag either edge of the
// passband, or shift+wheel over it. See the registry's `minimal`.
//
// The VFOs go because switching between four of them is not what a cut-down
// panel is for: a minimal Receiver is somebody who wants the dial and nothing
// else, and the VFOs have a panel of their own now for anyone who wants to see
// or switch them. They are also on the keyboard and mappable to a control
// surface, so nothing becomes unreachable by dropping the row.
export default function ReceiverPanel({ minimal }) {
    const { tuning, actions, running } = useRadio();
    // Shared with click-to-tune on the spectrum, so both land on the same grid.
    const display = useDisplay();
    const step = display.tuneStep || 500;
    const setStep = (hz) => display.set({ tuneStep: hz });

    const mode = MODE_BY_ID[tuning.mode] || MODES[0];
    const width = Math.abs(tuning.bandwidthHigh - tuning.bandwidthLow);
    const iq = isIQ(tuning.mode);

    // Lower-sideband modes are edited as a positive width around the carrier so
    // the sliders behave the same way regardless of sideband.
    // Shared with the spectrum's edge dragging and shift+wheel, so the two ways
    // of setting a filter width cannot disagree about what a width means.
    const setWidth = (w) => actions.setBandwidth(...edgesForWidth(tuning.mode, w, tuning));

    // Both halves of the shift live in constants.js beside the width's, so the
    // slider and the reset button next to it cannot read the same passband
    // differently — see filterShift.
    const setShift = (s) => actions.setBandwidth(...edgesForShift(tuning.mode, s, tuning));
    const shift = filterShift(tuning.mode, tuning.bandwidthLow, tuning.bandwidthHigh);

    return (
        <div className="stack">
            <FrequencyDial frequency={tuning.frequency} onChange={actions.setFrequency} />

            {!minimal && <VfoBar />}

            <div className="tune-row">
                <Button variant="ghost" icon={<Icon.Minus />} title={`− ${stepLabel(step)}`} onClick={() => actions.stepBy(step, -1)} />
                <select className="select" value={step} onChange={(e) => setStep(Number(e.target.value))}>
                    {TUNING_STEPS.map((s) => <option key={s} value={s}>{stepLabel(s)}</option>)}
                </select>
                <Button variant="ghost" icon={<Icon.Plus />} title={`+ ${stepLabel(step)}`} onClick={() => actions.stepBy(step, 1)} />
            </div>

            {/* No visible label: eight buttons reading USB, LSB, AM, FM… are
                what a mode picker looks like, and a word above them only
                restates it. The name is kept for anyone who cannot see the
                shape — a screen reader would otherwise meet eight unexplained
                buttons — hence the group rather than a bare div. */}
            <div role="group" aria-label="Mode">
                {/* Wraps to as many rows as the dock width needs: 4x2 at the
                    default width, never fewer than 3 columns when narrowed. */}
                <Segmented
                    minItemWidth={54}
                    size="sm"
                    value={tuning.mode}
                    onChange={actions.setMode}
                    options={MODES.map((m) => ({ value: m.id, label: m.label }))}
                />
            </div>

            {!minimal && (
                <>
                    {/* Fixed in IQ at the full ±5 kHz baseband — see the note on
                        actions.setBandwidth. Shown rather than hidden, and
                        reading 10.00 kHz, because the width is worth knowing
                        even when it cannot be changed. */}
                    {/* The reset is a sibling of the Field, not a child of it:
                        a Field is a <label>, and a button inside one is a click
                        two elements want — the same reason the Multipad's row
                        keeps its action outside. */}
                    <div className="filter-row">
                        <Field
                            label="Filter width"
                            hint={iq ? `${(width / 1000).toFixed(2)} kHz — fixed in IQ` : `${(width / 1000).toFixed(2)} kHz`}
                        >
                            <Slider
                                value={Math.min(width, maxFilterWidth(tuning.mode))}
                                min={FILTER_WIDTH_MIN}
                                max={maxFilterWidth(tuning.mode)}
                                step={FILTER_WIDTH_STEP}
                                onChange={setWidth}
                                disabled={iq}
                            />
                        </Field>
                        <FilterReset />
                    </div>

                    <div className="filter-row">
                        <Field label="Filter shift" hint={iq ? '0 Hz — fixed in IQ' : `${Math.round(shift)} Hz`}>
                            <Slider
                                value={Math.round(shift)}
                                min={-1500}
                                max={1500}
                                step={10}
                                onChange={setShift}
                                disabled={iq}
                            />
                        </Field>
                        <FilterReset what="shift" />
                    </div>

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
