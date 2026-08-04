import React from '../react.js';
import { useDisplay } from '../display/DisplayContext.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { PALETTE_NAMES, paletteGradient } from '../lib/palettes.js';
import { Button, Field, Icon, Segmented, Slider, Switch } from '../components/ui.jsx';


export default function DisplayPanel() {
    const d = useDisplay();
    const { serverInfo } = useRadio();
    const viewMode = d.viewMode || 'split';
    // null means the operator's default is in force; the slider shows that
    // value so moving it starts from what you are actually looking at.
    const minSpan = d.autoMinSpan != null ? d.autoMinSpan : d.server.autoMinSpan;

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

            <Field label="Scroll wheel" hint={d.wheelAction === 'tune' ? `steps ${d.tuneStep || 500} Hz` : undefined}>
                <Segmented
                    size="sm"
                    value={d.wheelAction || 'zoom'}
                    onChange={(v) => d.set({ wheelAction: v })}
                    options={[
                        { value: 'zoom', label: 'Zoom', title: 'Wheel zooms the spectrum' },
                        { value: 'tune', label: 'Tune', title: 'Wheel steps the frequency' },
                    ]}
                />
            </Field>

            {/* Only means something while the wheel zooms. Mirrored by the
                toggle in the spectrum toolbar, which writes the same setting. */}
            {(d.wheelAction || 'zoom') === 'zoom' && (
                <Field label="Zoom about">
                    <Segmented
                        size="sm"
                        value={d.zoomAnchor === 'tuned' ? 'tuned' : 'cursor'}
                        onChange={(v) => d.set({ zoomAnchor: v })}
                        options={[
                            { value: 'cursor', label: 'Cursor', title: 'Holds the frequency under the pointer still' },
                            { value: 'tuned', label: 'Tuned', title: 'Re-centres on the tuned frequency, as the toolbar buttons do' },
                        ]}
                    />
                </Field>
            )}

            <div className="divider" />

            <div className="section-label"><span>Markers</span></div>
            <Field label="Band allocations" inline>
                <Switch checked={d.markerBands !== false} onChange={(v) => d.set({ markerBands: v })} />
            </Field>
            <Field label="Server bookmarks" inline>
                <Switch checked={d.markerBookmarks !== false} onChange={(v) => d.set({ markerBookmarks: v })} />
            </Field>
            <Field label="Local bookmarks" inline>
                <Switch checked={d.markerLocalBookmarks !== false} onChange={(v) => d.set({ markerLocalBookmarks: v })} />
            </Field>
            {/* Only where the receiver runs the detector: with no noise floor
                monitor there is nothing behind this switch. */}
            {serverInfo?.noise_floor && (
                <Field label="Voice activity" inline>
                    <Switch checked={d.markerVoice !== false} onChange={(v) => d.set({ markerVoice: v })} />
                </Field>
            )}
            {/* Spot markers, each present only where that feed is. Digital
                spots have no switch on purpose — a decoder band puts every
                station on one frequency, so a marker per spot would be a stack
                of pills on a single pixel rather than somewhere to tune. */}
            {serverInfo?.dx_cluster && (
                <Field label="DX spots" inline>
                    <Switch checked={d.markerDxSpots !== false} onChange={(v) => d.set({ markerDxSpots: v })} />
                </Field>
            )}
            {serverInfo?.cw_skimmer && (
                <Field label="CW spots" inline>
                    <Switch checked={d.markerCwSpots !== false} onChange={(v) => d.set({ markerCwSpots: v })} />
                </Field>
            )}

            <div className="divider" />

            {/* Level mapping drives both panes. */}
            <Field label="Auto level" hint={d.autoRange ? 'tracking noise floor' : 'manual'} inline>
                <Switch checked={d.autoRange} onChange={(v) => d.set({ autoRange: v })} />
            </Field>

            {d.autoRange && (
                /* v1's "minimum dynamic range" slider: guarantees at least this
                   many dB are shown, so a quiet band does not get magnified
                   until noise ripple fills the height. 0 turns it off. The
                   default is the operator's `min_span` from /api/ui-config. */
                <Field
                    label="Min dynamic range"
                    hint={minSpan === 0 ? 'auto' : `${minSpan} dB`}
                >
                    <Slider
                        value={minSpan}
                        min={0}
                        max={60}
                        step={5}
                        onChange={(v) => d.set({ autoMinSpan: v })}
                    />
                </Field>
            )}

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

            <div className="row-end">
                <Button size="sm" variant="ghost" icon={<Icon.Reset />} onClick={d.reset}>Reset display</Button>
            </div>
        </div>
    );
}
