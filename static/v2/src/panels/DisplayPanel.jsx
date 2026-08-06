import React from '../react.js';
import { resolveZoomAnchor, useDisplay } from '../display/DisplayContext.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { PALETTE_NAMES, paletteGradient } from '../lib/palettes.js';
import { markColors } from '../display/uiConfig.js';
import { Button, ColorPicker, Field, Icon, Segmented, Slider, Switch } from '../components/ui.jsx';
import { MOBILE_QUERY, useMediaQuery } from '../lib/useMediaQuery.js';
import {
    THROTTLE_CHOICES, THROTTLE_MIN_DESKTOP, THROTTLE_MIN_MOBILE, throttleMinutes,
} from '../radio/idle.js';
import { haptic, hapticsSupported, setHapticMode, setHapticScopes } from '../lib/haptics.js';


export default function DisplayPanel() {
    const d = useDisplay();
    const { serverInfo } = useRadio();
    // Two settings resolve per device — the zoom anchor and the idle throttle —
    // and both have to show what is actually in force, not what is stored. The
    // same query IdleWatch and the spectrum use to decide, so the control and
    // the behaviour cannot disagree.
    const mobile = useMediaQuery(MOBILE_QUERY);
    // No vibrator, no setting: a switch that provably cannot do anything is
    // worse than none, and every desktop would carry it. See hapticsSupported.
    const canBuzz = hapticsSupported();
    const hapticMode = d.haptics || 'off';
    const hapticOn = hapticMode !== 'off';
    const viewMode = d.viewMode || 'split';

    // Both of these write straight into the haptics module as well as into the
    // settings, so the sample pulse is felt on this click rather than on the
    // next one: HapticWatch mirrors the same values, but its effect runs after
    // the render this click causes, by which point the pulse has been and gone.
    const setHaptics = (v) => {
        setHapticMode(v);
        d.set({ haptics: v });
        haptic('toggle');
    };

    // A switch turned on demonstrates itself, with a pulse from the scope it
    // just enabled. Turned off there is deliberately nothing to feel.
    const setScope = (key, on, kind, scope) => {
        const next = { ui: d.hapticButtons !== false, spectrum: d.hapticSpectrum !== false, [scope]: on };
        setHapticScopes(next);
        d.set({ [key]: on });
        if (on) haptic(kind, scope);
    };
    // null means the operator's default is in force; the slider shows that
    // value so moving it starts from what you are actually looking at.
    const minSpan = d.autoMinSpan != null ? d.autoMinSpan : d.server.autoMinSpan;

    // Controls that only affect one pane are hidden when that pane is not on
    // screen — otherwise the panel offers settings with no visible effect.
    const hasSpectrum = viewMode !== 'waterfall';
    const hasWaterfall = viewMode !== 'spectrum';

    return (
        <div className="stack">
            {/* The top bar's toggle is desktop-only — on a phone the space it
                took belongs to the frequency, the mode and the filter width —
                so this is where the theme lives on mobile, and it is a display
                setting either way. */}
            <Field label="Theme">
                <Segmented
                    size="sm"
                    value={d.theme === 'light' ? 'light' : 'dark'}
                    onChange={(v) => d.set({ theme: v })}
                    options={[
                        { value: 'dark', label: 'Dark' },
                        { value: 'light', label: 'Light' },
                    ]}
                />
            </Field>

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
                <>
                    <Field label="Split" hint={`${Math.round(d.split * 100)} % spectrum`}>
                        <Slider value={Math.round(d.split * 100)} min={10} max={85} onChange={(v) => d.set({ split: v / 100 })} />
                    </Field>
                    {/* The same setting from the other end: the slider is where
                        you set the share deliberately, this is whether the join
                        between the panes can be grabbed to do it by hand. */}
                    <Field label="Drag to adjust" inline>
                        <Switch
                            checked={d.splitDrag !== false}
                            onChange={(v) => d.set({ splitDrag: v })}
                            title="Drag the frequency scale up or down to re-share the height between the two panes. Turn this off if you keep moving it by accident when reaching for the scale — the slider above and the double-click reset still work"
                        />
                    </Field>
                </>
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

            {/* Read by wheel zoom and by the spectrum's pinch. Mirrored by the
                toggle in the spectrum toolbar, which writes the same setting —
                that one only ever writes an explicit choice, so pressing it is
                how you leave Auto. */}
            {(d.wheelAction || 'zoom') === 'zoom' && (
                <Field
                    label="Zoom about"
                    hint={d.zoomAnchor === 'cursor' || d.zoomAnchor === 'tuned'
                        ? undefined
                        : `auto \u2192 ${resolveZoomAnchor(d.zoomAnchor, mobile)}`}
                >
                    <Segmented
                        size="sm"
                        value={d.zoomAnchor === 'tuned' || d.zoomAnchor === 'cursor' ? d.zoomAnchor : 'auto'}
                        onChange={(v) => d.set({ zoomAnchor: v })}
                        options={[
                            { value: 'auto', label: 'Auto', title: 'Cursor where there is a pointer, tuned on a phone — where a pinch has no cursor to hold still and the dial is what you are watching' },
                            { value: 'cursor', label: 'Cursor', title: 'Holds the frequency under the pointer or the fingers still' },
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

            {/* Directly under the palette because that is what they answer to:
                the marks have to contrast with the colour map, and each palette
                remembers its own pair. Changing palette therefore changes what
                these two show, which is the point. */}
            <MarkColors />

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

                    <Field label="Smooth scrolling" inline>
                        <Switch
                            checked={d.smoothScroll !== false}
                            onChange={(v) => d.set({ smoothScroll: v })}
                            title="Slide each row into view instead of letting it step in. Most noticeable on a wide span, where the receiver sends fewer frames a second. Costs no extra work per frame, but the picture is very slightly softer while it is moving"
                        />
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

                    {/* Lines only. The dB numbers down the left edge are the
                        vertical axis and are always drawn — see drawSpectrum. */}
                    <Field label="Grid lines" inline>
                        <Switch
                            checked={d.grid}
                            onChange={(v) => d.set({ grid: v })}
                            title="Horizontal rules across the spectrum at each labelled dB step. The dB numbers themselves are always shown"
                        />
                    </Field>
                </>
            )}

            {/* No note under this one: the label says what it does. The tooltip
                carries the part that is not obvious — that it is a collapsed
                dock's rail, and that clicking still opens the dock for good. */}
            <Field label="Show panels on hover" inline>
                <Switch
                    checked={d.hoverPanels !== false}
                    onChange={(v) => d.set({ hoverPanels: v })}
                    title="Resting the pointer on a collapsed dock's rail slides it out over the receiver, and moving away puts it back. Clicking the rail still opens or closes the dock for good"
                />
            </Field>

            {/* Touch only, so the whole section is absent where there is
                nothing to vibrate — see hapticsSupported. */}
            {canBuzz && (
                <>
                    <div className="divider" />

                    <div className="section-label"><span>Haptics</span></div>
                    {/* The master switch. Off here means off everywhere, and
                        the two scope switches below go with it rather than
                        staying on screen doing nothing. */}
                    <Field label="Vibrate on touch" inline>
                        <Switch
                            checked={hapticOn}
                            onChange={(v) => setHaptics(v ? 'medium' : 'off')}
                            title="Vibrate when something responds to your finger"
                        />
                    </Field>
                    {hapticOn && (
                        <>
                            <Field label="Strength">
                                <Segmented
                                    size="sm"
                                    value={hapticMode}
                                    onChange={setHaptics}
                                    options={[
                                        { value: 'light', label: 'Light' },
                                        { value: 'medium', label: 'Medium' },
                                        { value: 'strong', label: 'Strong' },
                                    ]}
                                />
                            </Field>

                            {/* Two scopes, because they are two different
                                questions — see lib/haptics.js. Buttons are
                                confirmation of a press you meant; the spectrum
                                is the display reporting a result you cannot
                                see, usually because your own finger is over it. */}
                            <Field label="Button presses" inline>
                                <Switch
                                    checked={d.hapticButtons !== false}
                                    onChange={(v) => setScope('hapticButtons', v, 'tap', 'ui')}
                                    title="Every control in the app"
                                />
                            </Field>
                            <Field label="Spectrum &amp; waterfall" inline>
                                <Switch
                                    checked={d.hapticSpectrum !== false}
                                    onChange={(v) => setScope('hapticSpectrum', v, 'tune', 'spectrum')}
                                    title="Tap to tune, pinch zoom, pan, filter edges"
                                />
                            </Field>
                        </>
                    )}
                </>
            )}

            <div className="divider" />

            {/* Not a look but a cost: how much spectrum data this session asks
                for while nobody is using it. It lives here because this is the
                panel that owns everything about the spectrum you can see, and
                because the effect of it — a waterfall that slows down on its
                own — is something you notice here first. The Status panel's
                "Poll rate" says what it is doing at any moment. */}
            <div className="section-label"><span>Data</span></div>
            {/* A list, not a switch: "how long am I prepared to be counted as
                away" is the actual question, and the old switch answered it with
                a number the panel could only describe. `null` is not an option
                of its own — it resolves to this device's default and shows as
                that, so the control always reads as the delay in force. */}
            <Field
                label="Slow down when idle"
                hint={d.idleThrottleMin == null ? 'default for this device' : undefined}
                inline
            >
                <Segmented
                    size="sm"
                    minItemWidth={34}
                    value={String(throttleMinutes(d.idleThrottleMin, mobile))}
                    onChange={(v) => d.set({ idleThrottleMin: Number(v) })}
                    options={THROTTLE_CHOICES.map((m) => ({
                        value: String(m),
                        label: m === 0 ? 'Never' : `${m}m`,
                        title: m === 0
                            ? 'Always poll at the full rate'
                            : `Halve the spectrum rate after ${m} minutes of no input`,
                    }))}
                />
            </Field>
            <div className="note note--tight">
                Asks the server to poll the spectrum at half rate after this long with no
                input, and restores it on the first move, key or tap. Defaults
                to {THROTTLE_MIN_DESKTOP} minutes, {THROTTLE_MIN_MOBILE} on a phone.
            </div>

            <div className="row-end">
                <Button size="sm" variant="ghost" icon={<Icon.Reset />} onClick={d.reset}>Reset display</Button>
            </div>
        </div>
    );
}

// The dial line and the passband edges, for the palette in force.
//
// Two pickers rather than one, because the two lines answer different questions
// and want to be told apart on sight: the dial is where you are listening and
// the edges are how wide. Both open on the colour actually being drawn — the
// palette's own choice until somebody overrides it — so a first drag starts from
// something sensible rather than from black.
function MarkColors() {
    const d = useDisplay();
    const { dial, edge } = markColors(d);
    const mine = (d.markOverrides && d.markOverrides[d.palette]) || {};
    const hint = mine.dial || mine.edge ? `custom for ${d.palette}` : `chosen for ${d.palette}`;

    return (
        <Field label="Marker colours" hint={hint}>
            <div className="markcolors">
                <label className="markcolors__row">
                    <span className="markcolors__name">Dial</span>
                    <ColorPicker
                        value={dial}
                        ariaLabel="Dial line colour"
                        title="The line on the frequency you are tuned to"
                        onChange={(v) => d.setMarkColor(d.palette, 'dial', v)}
                        onClear={() => d.setMarkColor(d.palette, 'dial', '')}
                        inherited={!mine.dial}
                    />
                </label>
                <label className="markcolors__row">
                    <span className="markcolors__name">Passband</span>
                    <ColorPicker
                        value={edge}
                        ariaLabel="Passband edge colour"
                        title="The two lines showing what is being demodulated"
                        onChange={(v) => d.setMarkColor(d.palette, 'edge', v)}
                        onClear={() => d.setMarkColor(d.palette, 'edge', '')}
                        inherited={!mine.edge}
                    />
                </label>
            </div>
        </Field>
    );
}
