// Client-side audio filters: EQ, notches and a bandpass.
//
// These mirror v1's filter cards (static/filters.js) — same designs, same
// numbers, same presets — so a receiver sounds identical in both frontends.
// The parameter maths and the node building live in radio/audio-filters.js;
// this is the controls.

import React, { useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Button, Field, Icon, Segmented, Slider, Switch } from '../components/ui.jsx';
import { audioWindow } from '../lib/audioBand.js';
import {
    EQ_FREQUENCIES, EQ_GAIN_MAX, EQ_GAIN_MIN, FILTER_DEFAULTS, MAX_NOTCHES,
    bandpassRange, detectPreset, presetGains,
} from '../radio/audio-filters.js';

const PRESETS = [
    { value: 'flat', label: 'Flat' },
    { value: 'voice', label: 'Voice' },
    { value: 'cw', label: 'CW' },
    { value: 'music', label: 'Music' },
];

const fmtGain = (g) => `${g > 0 ? '+' : ''}${g.toFixed(1)}`;
const fmtBand = (f) => (f >= 1000 ? `${f / 1000}k` : String(f));

function Section({ title, enabled, onToggle, children, extra }) {
    return (
        <>
            <div className="section-label">
                <span>{title}</span>
                {extra}
            </div>
            <Field label={enabled ? 'On' : 'Off'} inline>
                <Switch checked={enabled} onChange={onToggle} />
            </Field>
            {enabled && children}
        </>
    );
}

export default function AudioFiltersPanel() {
    const { filters, actions, tuning } = useRadio();
    const [tab, setTab] = useState('eq');

    const eq = filters.eq;
    const notch = filters.notch;
    const bp = filters.bandpass;
    const preset = detectPreset(eq.gains) || 'flat';

    // The bandpass can only sit inside the audio this mode carries, which is
    // what v1 recomputes whenever the passband changes.
    const range = bandpassRange(audioWindow(tuning.bandwidthLow, tuning.bandwidthHigh));
    const centre = Math.min(range.max, Math.max(range.min, bp.center));

    const setEq = (patch) => actions.setFilters({ eq: { ...eq, ...patch } });
    const setNotch = (patch) => actions.setFilters({ notch: { ...notch, ...patch } });
    const setBp = (patch) => actions.setFilters({ bandpass: { ...bp, ...patch } });

    const setBand = (i, value) => {
        const gains = eq.gains.slice();
        gains[i] = value;
        setEq({ gains });
    };

    const applyPreset = (name) => {
        if (name === 'flat') {
            setEq({ enabled: true, gains: EQ_FREQUENCIES.map(() => 0), makeup: 0 });
            return;
        }
        const p = presetGains(name);
        if (p) setEq({ enabled: true, ...p });
    };

    const addNotch = () => {
        if (notch.items.length >= MAX_NOTCHES) return;
        // v1 drops a new notch in the middle of the passband.
        const w = audioWindow(tuning.bandwidthLow, tuning.bandwidthHigh);
        const center = Math.round((w.startFreq + w.endFreq) / 2);
        setNotch({ enabled: true, items: notch.items.concat({ center, width: 50 }) });
    };

    const setNotchAt = (i, patch) => {
        const items = notch.items.slice();
        items[i] = { ...items[i], ...patch };
        setNotch({ items });
    };

    return (
        <div className="stack">
            <Segmented
                options={[
                    { value: 'eq', label: 'EQ' },
                    { value: 'notch', label: `Notch${notch.items.length ? ` ${notch.items.length}` : ''}` },
                    { value: 'bandpass', label: 'Bandpass' },
                ]}
                value={tab}
                onChange={setTab}
                size="sm"
            />

            {tab === 'eq' && (
                <Section
                    title="Equaliser"
                    enabled={eq.enabled}
                    onToggle={(v) => setEq({ enabled: v })}
                    extra={<span className="section-label__note">{preset}</span>}
                >
                    <Segmented options={PRESETS} value={preset} onChange={applyPreset} size="sm" />

                    {/* Twelve bands, 60 Hz to 8 kHz, ±12 dB — v1's set. */}
                    <div className="eqbands">
                        {EQ_FREQUENCIES.map((freq, i) => (
                            <div className="eqband" key={freq}>
                                <span className="eqband__hz">{fmtBand(freq)}</span>
                                <Slider
                                    value={eq.gains[i] || 0}
                                    min={EQ_GAIN_MIN}
                                    max={EQ_GAIN_MAX}
                                    step={0.5}
                                    onChange={(v) => setBand(i, v)}
                                />
                                <span className="eqband__db">{fmtGain(eq.gains[i] || 0)}</span>
                            </div>
                        ))}
                    </div>

                    <Field label="Makeup gain" hint={`${fmtGain(eq.makeup || 0)} dB`}>
                        <Slider
                            value={eq.makeup || 0}
                            min={EQ_GAIN_MIN}
                            max={EQ_GAIN_MAX}
                            step={0.5}
                            onChange={(v) => setEq({ makeup: v })}
                        />
                    </Field>

                    <div className="row-end">
                        <Button size="sm" variant="ghost" onClick={() => applyPreset('flat')}>Reset</Button>
                    </div>
                </Section>
            )}

            {tab === 'notch' && (
                <Section
                    title="Notch filters"
                    enabled={notch.enabled}
                    onToggle={(v) => setNotch({ enabled: v })}
                    extra={<span className="section-label__note">{notch.items.length}/{MAX_NOTCHES}</span>}
                >
                    {notch.items.length === 0 && (
                        <div className="note note--tight">
                            Add a notch to pull down a carrier or a heterodyne.
                        </div>
                    )}

                    {notch.items.map((n, i) => (
                        <div className="notch" key={i}>
                            <div className="notch__head">
                                <span className="notch__name">Notch {i + 1}</span>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    icon={<Icon.Close size={12} />}
                                    title="Remove"
                                    onClick={() => setNotch({ items: notch.items.filter((_, k) => k !== i) })}
                                />
                            </div>
                            <Field label="Centre" hint={`${Math.round(n.center)} Hz`}>
                                <Slider
                                    value={n.center}
                                    min={range.min}
                                    max={range.max}
                                    step={5}
                                    onChange={(v) => setNotchAt(i, { center: v })}
                                />
                            </Field>
                            <Field label="Width" hint={`${n.width} Hz`}>
                                <Slider
                                    value={n.width}
                                    min={10}
                                    max={500}
                                    step={5}
                                    onChange={(v) => setNotchAt(i, { width: v })}
                                />
                            </Field>
                        </div>
                    ))}

                    <div className="row-end">
                        <Button
                            size="sm"
                            variant="primary"
                            icon={<Icon.Plus size={13} />}
                            disabled={notch.items.length >= MAX_NOTCHES}
                            onClick={addNotch}
                        >
                            Add notch
                        </Button>
                    </div>
                </Section>
            )}

            {tab === 'bandpass' && (
                <Section
                    title="Bandpass"
                    enabled={bp.enabled}
                    onToggle={(v) => setBp({ enabled: v })}
                >
                    <Field label="Centre" hint={`${centre} Hz`}>
                        <Slider
                            value={centre}
                            min={range.min}
                            max={range.max}
                            step={10}
                            onChange={(v) => setBp({ center: v })}
                        />
                    </Field>
                    <Field label="Width" hint={`${bp.width} Hz`}>
                        <Slider value={bp.width} min={20} max={1000} step={10} onChange={(v) => setBp({ width: v })} />
                    </Field>
                    <Field label="Stages" hint={`${bp.stages} (${bp.stages * 12} dB/oct)`}>
                        <Slider value={bp.stages} min={1} max={6} step={1} onChange={(v) => setBp({ stages: v })} />
                    </Field>
                    <Field label="Auto Q" inline>
                        <Switch checked={bp.autoQ} onChange={(v) => setBp({ autoQ: v })} />
                    </Field>
                    {!bp.autoQ && (
                        <Field label="Q multiplier" hint={`${bp.qMultiplier.toFixed(1)}×`}>
                            <Slider
                                value={bp.qMultiplier}
                                min={0.1}
                                max={5}
                                step={0.1}
                                onChange={(v) => setBp({ qMultiplier: v })}
                            />
                        </Field>
                    )}
                    <div className="row-end">
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setBp({ ...FILTER_DEFAULTS.bandpass, enabled: bp.enabled })}
                        >
                            Reset
                        </Button>
                    </div>
                </Section>
            )}
        </div>
    );
}
