import React from '../react.js';
import { useDisplay } from '../display/DisplayContext.jsx';
import { PALETTE_NAMES, paletteGradient } from '../lib/palettes.js';
import { Button, Field, Icon, Segmented, Slider, Switch } from '../components/ui.jsx';

const SNAP_STEPS = [1, 10, 100, 500, 1000, 5000];

export default function DisplayPanel() {
    const d = useDisplay();
    const viewMode = d.viewMode || 'split';

    // Controls that only affect one pane are hidden when that pane is not on
    // screen — otherwise the panel offers settings with no visible effect.
    const hasSpectrum = viewMode !== 'waterfall';
    const hasWaterfall = viewMode !== 'spectrum';

    return (
        <div className="stack">
            <Field label="View">
                <Segmented
                    size="sm"
                    value={viewMode}
                    onChange={(v) => d.set({ viewMode: v })}
                    options={[
                        { value: 'split', label: 'Split', title: 'Spectrum above waterfall' },
                        { value: 'spectrum', label: 'Spectrum', title: 'Spectrum only' },
                        { value: 'waterfall', label: 'Waterfall', title: 'Waterfall only' },
                    ]}
                />
            </Field>

            {viewMode === 'split' && (
                <Field label="Split" hint={`${Math.round(d.split * 100)} % spectrum`}>
                    <Slider value={Math.round(d.split * 100)} min={10} max={85} onChange={(v) => d.set({ split: v / 100 })} />
                </Field>
            )}

            <div className="divider" />

            <div className="section-label"><span>Markers</span></div>
            <Field label="Band allocations" inline>
                <Switch checked={d.markerBands !== false} onChange={(v) => d.set({ markerBands: v })} />
            </Field>
            <Field label="Bookmarks" inline>
                <Switch checked={d.markerBookmarks !== false} onChange={(v) => d.set({ markerBookmarks: v })} />
            </Field>

            <div className="divider" />

            {/* Level mapping drives both panes. */}
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

            {/* Palette and contrast colour both panes — the spectrum trace and
                its fill use the same amplitude-to-colour mapping as the
                waterfall — so they stay visible in every view mode. */}
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

            <Field label="Contrast" hint={d.contrast.toFixed(2)}>
                <Slider value={d.contrast} min={0.4} max={2.5} step={0.05} onChange={(v) => d.set({ contrast: v })} />
            </Field>

            {hasWaterfall && (
                <>
                    <Field label="Waterfall speed" hint={`${d.waterfallRate} rows/s`}>
                        <Slider value={d.waterfallRate} min={2} max={40} onChange={(v) => d.set({ waterfallRate: v })} />
                    </Field>

                    <Field label="Row height" hint={`${d.rowHeight} px`}>
                        <Slider value={d.rowHeight} min={1} max={4} onChange={(v) => d.set({ rowHeight: v })} />
                    </Field>
                </>
            )}

            {hasSpectrum && (
                <>
                    <div className="divider" />

                    <Field label="Trace smoothing" hint={d.smoothing === 0 ? 'off' : d.smoothing.toFixed(2)}>
                        <Slider value={d.smoothing} min={0} max={0.92} step={0.02} onChange={(v) => d.set({ smoothing: v })} />
                    </Field>

                    <Field label="Fill under trace" inline>
                        <Switch checked={d.fill !== false} onChange={(v) => d.set({ fill: v })} />
                    </Field>

                    <Field label="Peak hold" inline>
                        <Switch checked={d.peakHold} onChange={(v) => d.set({ peakHold: v })} />
                    </Field>

                    {d.peakHold && (
                        <Field label="Peak decay" hint={d.peakDecay > 0 ? `${d.peakDecay} dB/s` : 'hold'}>
                            <Slider
                                value={d.peakDecay}
                                min={0}
                                max={20}
                                step={0.5}
                                onChange={(v) => d.set({ peakDecay: v })}
                            />
                        </Field>
                    )}

                    <Field label="dB grid" inline>
                        <Switch checked={d.grid} onChange={(v) => d.set({ grid: v })} />
                    </Field>
                </>
            )}

            <div className="divider" />

            <Field label="Click-to-tune snap" hint={d.snapHz > 1 ? `${d.snapHz} Hz` : 'off'}>
                <Slider
                    value={Math.max(0, SNAP_STEPS.indexOf(d.snapHz))}
                    min={0}
                    max={SNAP_STEPS.length - 1}
                    onChange={(i) => d.set({ snapHz: SNAP_STEPS[i] })}
                />
            </Field>

            <div className="row-end">
                <Button size="sm" variant="ghost" icon={<Icon.Reset />} onClick={d.reset}>Reset display</Button>
            </div>
        </div>
    );
}
