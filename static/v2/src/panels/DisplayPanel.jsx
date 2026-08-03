import React from '../react.js';
import { useDisplay } from '../display/DisplayContext.jsx';
import { PALETTE_NAMES, paletteGradient } from '../lib/palettes.js';
import { Button, Field, Icon, Slider, Switch } from '../components/ui.jsx';

export default function DisplayPanel() {
    const d = useDisplay();

    return (
        <div className="stack">
            <Field label="Palette">
                <div className="palette-grid">
                    {PALETTE_NAMES.map((name) => (
                        <button
                            key={name}
                            type="button"
                            title={name}
                            className={`palette${d.palette === name ? ' is-active' : ''}`}
                            style={{ backgroundImage: paletteGradient(name) }}
                            onClick={() => d.set({ palette: name })}
                        />
                    ))}
                </div>
            </Field>

            <Field label="Auto level" hint={d.autoRange ? 'tracking noise floor' : 'manual'} inline>
                <Switch checked={d.autoRange} onChange={(v) => d.set({ autoRange: v })} />
            </Field>

            {!d.autoRange && (
                <>
                    <Field label="Floor" hint={`${d.floorDb} dB`}>
                        <Slider value={d.floorDb} min={-160} max={-40} onChange={(v) => d.set({ floorDb: Math.min(v, d.ceilDb - 10) })} />
                    </Field>
                    <Field label="Ceiling" hint={`${d.ceilDb} dB`}>
                        <Slider value={d.ceilDb} min={-120} max={0} onChange={(v) => d.set({ ceilDb: Math.max(v, d.floorDb + 10) })} />
                    </Field>
                </>
            )}

            <Field label="Contrast" hint={d.contrast.toFixed(2)}>
                <Slider value={d.contrast} min={0.4} max={2.5} step={0.05} onChange={(v) => d.set({ contrast: v })} />
            </Field>

            <div className="divider" />

            <Field label="Trace smoothing" hint={d.smoothing === 0 ? 'off' : d.smoothing.toFixed(2)}>
                <Slider value={d.smoothing} min={0} max={0.92} step={0.02} onChange={(v) => d.set({ smoothing: v })} />
            </Field>

            <Field label="Peak hold" inline>
                <Switch checked={d.peakHold} onChange={(v) => d.set({ peakHold: v })} />
            </Field>

            <Field label="dB grid" inline>
                <Switch checked={d.grid} onChange={(v) => d.set({ grid: v })} />
            </Field>

            <div className="divider" />

            <Field label="Waterfall speed" hint={`${d.waterfallRate} rows/s`}>
                <Slider value={d.waterfallRate} min={2} max={40} onChange={(v) => d.set({ waterfallRate: v })} />
            </Field>

            <Field label="Row height" hint={`${d.rowHeight} px`}>
                <Slider value={d.rowHeight} min={1} max={4} onChange={(v) => d.set({ rowHeight: v })} />
            </Field>

            <Field label="Spectrum / waterfall split" hint={`${Math.round(d.split * 100)} %`}>
                <Slider value={Math.round(d.split * 100)} min={10} max={85} onChange={(v) => d.set({ split: v / 100 })} />
            </Field>

            <div className="divider" />

            <Field label="Click-to-tune snap" hint={d.snapHz > 1 ? `${d.snapHz} Hz` : 'off'}>
                <Slider
                    value={[1, 10, 100, 500, 1000, 5000].indexOf(d.snapHz) < 0 ? 0 : [1, 10, 100, 500, 1000, 5000].indexOf(d.snapHz)}
                    min={0}
                    max={5}
                    onChange={(i) => d.set({ snapHz: [1, 10, 100, 500, 1000, 5000][i] })}
                />
            </Field>

            <div className="row-end">
                <Button size="sm" variant="ghost" icon={<Icon.Reset />} onClick={d.reset}>Reset display</Button>
            </div>
        </div>
    );
}
