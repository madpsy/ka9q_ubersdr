// Server-side noise reduction.
//
// Which filters exist, and which parameters each one has, comes entirely from
// the server's `get_dsp_filters` reply — nothing about nr2/rn2/nr4/dfnr is
// hardcoded here, so a filter added to the DSP container shows up on its own.
// Controls are chosen from each parameter's declared type and range by
// lib/dsp.js.

import React from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Field, Segmented, Slider, Switch } from '../components/ui.jsx';
import { isIQ } from '../radio/constants.js';
import {
    boolValue, computeStep, controlKind, formatParamName, formatParamValue,
    paramHelp, parseEnum, runtimeParams,
} from '../lib/dsp.js';

function Param({ param, value, onChange }) {
    const kind = controlKind(param);
    const help = paramHelp(param);

    if (kind === 'bool') {
        return (
            <>
                <Field label={formatParamName(param.name)} inline>
                    <Switch checked={boolValue(value)} onChange={(v) => onChange(v)} />
                </Field>
                {help && <div className="param-help">{help}</div>}
            </>
        );
    }

    if (kind === 'enum') {
        const options = parseEnum(param).map((o) => ({ value: String(o.value), label: o.label }));
        return (
            <>
                <Field label={formatParamName(param.name)}>
                    <Segmented
                        size="sm"
                        minItemWidth={64}
                        value={String(Math.round(Number(value)))}
                        onChange={onChange}
                        options={options}
                    />
                </Field>
                {help && <div className="param-help">{help}</div>}
            </>
        );
    }

    if (kind === 'slider') {
        return (
            <>
                <Field label={formatParamName(param.name)} hint={formatParamValue(value, param)}>
                    <Slider
                        value={Number(value)}
                        min={Number(param.min)}
                        max={Number(param.max)}
                        step={computeStep(param)}
                        onChange={onChange}
                    />
                </Field>
                {help && <div className="param-help">{help}</div>}
            </>
        );
    }

    return (
        <Field label={formatParamName(param.name)} hint={help || undefined}>
            <input
                className="input"
                value={value ?? ''}
                placeholder={param.default || ''}
                onChange={(e) => onChange(e.target.value)}
            />
        </Field>
    );
}

// `minimal` keeps the switch and the filter chips — on, off, and which — and
// drops the description, the parameters and their Defaults reset. The chips
// stay because on a phone "NR3 instead of NR2" is a real mid-session change;
// the parameters are tuning, done once at the desk.
export default function DspControl({ minimal }) {
    const { dsp, actions, running, tuning } = useRadio();

    // Refused by the server, not merely pointless: set_dsp on an IQ session is
    // answered with "DSP insert cannot be used with IQ modes", and the insert
    // is skipped in the streaming loop regardless. Said here so the answer is
    // the panel's rather than an error arriving from the socket.
    if (isIQ(tuning.mode)) {
        return (
            <div className="note note--tight">
                Not available in IQ mode — the receiver only runs its noise
                reduction on demodulated audio.
            </div>
        );
    }

    // Nothing is known until a session is up and the server has answered.
    if (!running || dsp.schemas === null) {
        return (
            <div className="note note--tight">
                {running ? 'Reading filters from the receiver…' : 'Start the receiver to load noise reduction.'}
            </div>
        );
    }

    if (dsp.schemas.length === 0) {
        return (
            <div className="note note--tight">
                {dsp.unavailableReason || 'Not available on this receiver.'}
            </div>
        );
    }

    const schema = dsp.schemas.find((f) => f.name === dsp.filter);
    const params = runtimeParams(schema);
    const values = (dsp.params && dsp.params[dsp.filter]) || {};

    return (
        <>
            <Field label="Filter" hint={dsp.enabled ? 'on' : 'off'} inline>
                <Switch
                    checked={dsp.enabled}
                    onChange={(on) => actions.setDsp(dsp.filter, on)}
                />
            </Field>

            <div className="chip-row chip-row--wrap">
                {dsp.schemas.map((f) => (
                    <button
                        key={f.name}
                        type="button"
                        title={f.description || f.name}
                        className={`chip chip--button${dsp.filter === f.name ? ' is-active' : ''}`}
                        onClick={() => actions.setDsp(f.name, dsp.enabled)}
                    >
                        {f.name.toUpperCase()}
                    </button>
                ))}
            </div>

            {!minimal && schema && schema.description && (
                <div className="param-help">{schema.description}</div>
            )}

            {/* Parameters belong to the running filter, so they are only shown
                — and only accepted by the server — while the insert is on. */}
            {!minimal && dsp.enabled && params.length === 0 && (
                <div className="note note--tight">This filter has no adjustable settings.</div>
            )}

            {!minimal && dsp.enabled && params.length > 0 && (
                <div className="section-label">
                    <span>Settings</span>
                    <button type="button" className="chip chip--button" onClick={actions.resetDspParams}>
                        Defaults
                    </button>
                </div>
            )}

            {!minimal && dsp.enabled && params.map((p) => (
                <Param
                    key={p.name}
                    param={p}
                    value={values[p.name] ?? p.default}
                    onChange={(v) => actions.setDspParam(p.name, v)}
                />
            ))}
        </>
    );
}
