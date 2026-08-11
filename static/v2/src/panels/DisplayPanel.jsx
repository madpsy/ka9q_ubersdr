import React from '../react.js';
import { resolveZoomAnchor, useDisplay } from '../display/DisplayContext.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { PALETTE_NAMES, paletteGradient } from '../lib/palettes.js';
import { markColors } from '../display/uiConfig.js';
import { MAX_SECONDS, MIN_SECONDS } from '../lib/dss.js';
import { clamp } from '../lib/format.js';
import { Button, ColorPicker, Field, Icon, Segmented, Slider, Switch } from '../components/ui.jsx';
import { MOBILE_QUERY, useMediaQuery } from '../lib/useMediaQuery.js';
import {
    PAUSE_CHOICES, PAUSE_MIN_MOBILE, THROTTLE_CHOICES, THROTTLE_MIN_DESKTOP,
    THROTTLE_MIN_MOBILE, pauseMinutes, throttleMinutes,
} from '../radio/idle.js';
import { statsPlace } from '../lib/spectrumStats.js';
import {
    PEAK_COUNTS, PEAK_SNR_CHOICES, peakCount, peakPlace, peakSnr,
} from '../lib/spectrumPeaks.js';
import { packetAvailable } from '../lib/packet.js';
import { voiceSkimmerAvailable } from '../lib/voiceSkimmer.js';
import {
    UI_THEMES, canvasContrast, contrastMin, effectiveColors, matchUiTheme, pageContrast,
    themeSwatch, uiColorsFrom,
} from '../lib/uiColors.js';
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

            <UiColors />

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
                    <Field label="Drag divider to adjust" inline>
                        <Switch
                            checked={d.splitDrag !== false}
                            onChange={(v) => d.set({ splitDrag: v })}
                            title="Drag the frequency scale up or down to re-share the height between the two panes. Turn this off if you keep moving it by accident when reaching for the scale — the slider above and the double-click reset still work"
                        />
                    </Field>
                </>
            )}

            {/* The other thing on the spectrum that can be grabbed by mistake,
                and the more expensive of the two to get wrong: the splitter
                above only re-shares the display, where this changes what you are
                hearing. Outside the split-only block, because the passband edges
                are on the spectrum in every view mode. */}
            <Field label="Drag passband edges" inline>
                <Switch
                    checked={d.edgeDrag !== false}
                    onChange={(v) => d.set({ edgeDrag: v })}
                    title="Drag either edge of the passband on the spectrum to set the filter width. Turn this off if you keep catching one when reaching to tune — the Receiver panel's slider, the top bar's filter chip and the Multipad all still set it"
                />
            </Field>

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

            {/* Phone only, and only worth offering there: on a desktop the panels are
                docks and there is no row of names to keep. */}
            {mobile && (
                <Field
                    label="Keep panel bar"
                    hint={d.mobileTabsAlways ? 'always shown' : 'hidden while a panel is open'}
                    inline
                >
                    <Switch
                        checked={!!d.mobileTabsAlways}
                        onChange={(v) => d.set({ mobileTabsAlways: v })}
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
            {/* Where the other VFOs are parked. Never the one you are on — that
                is the dial, and the spectrum marks it already. */}
            <Field label="VFOs" inline>
                <Switch checked={d.markerVfos !== false} onChange={(v) => d.set({ markerVfos: v })} />
            </Field>
            {/* Only where the receiver runs the detector: with no noise floor
                monitor there is nothing behind this switch. */}
            {serverInfo?.noise_floor && (
                <Field label="Voice activity" inline>
                    <Switch checked={d.markerVoice !== false} onChange={(v) => d.set({ markerVoice: v })} />
                </Field>
            )}
            {/* Only where the voice skimmer addon is installed. The callsigns from
                its Confirmed column — heard on SSB and validated — which is a
                different marker from the voice activity above: one says speech was
                heard, this one says who it was. */}
            {voiceSkimmerAvailable(serverInfo) && (
                <Field label="Confirmed voice" inline>
                    <Switch
                        checked={d.markerVoiceConfirmed !== false}
                        onChange={(v) => d.set({ markerVoiceConfirmed: v })}
                    />
                </Field>
            )}
            {/* Only where the packet addon is installed. One pill per configured
                channel, naming the stations heard on it — the tooltip has who is
                working whom, which is the part a pill has no room for. */}
            {packetAvailable(serverInfo) && (
                <Field label="Packet channels" inline>
                    <Switch checked={d.markerPacket !== false} onChange={(v) => d.set({ markerPacket: v })} />
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
                    {/* How the same history is drawn, which is why it sits with
                        the speed and the pan rather than with the view mode: the
                        view mode says whether there is a waterfall, this says
                        what it looks like. See lib/dss.js. */}
                    <Field
                        label="Waterfall style"
                        hint={d.waterfallMode === '2d' ? undefined : 'perspective history'}
                    >
                        <Segmented
                            value={d.waterfallMode || '2d'}
                            onChange={(v) => d.set({ waterfallMode: v })}
                            options={[
                                { value: '2d', label: '2D', title: 'Heat map — the classic waterfall' },
                                { value: '3d', label: '3D', title: 'Perspective stack of recent traces' },
                                { value: 'both', label: '2D+3D', title: 'Both, newest rows meeting in the middle' },
                            ]}
                        />
                    </Field>
                    {/* Only where there is a surface to set the depth of. The
                        2D waterfall's own history is however much fits the pane,
                        which is not a thing anybody sets in seconds. */}
                    {d.waterfallMode !== '2d' && (
                        /* Plain seconds, and the same seconds on screen: a row
                           is placed by how long ago it arrived, so the span is
                           the setting and nothing has to be derived from how
                           fast rows are turning up. Deriving it is what had the
                           slider's own bounds — and its thumb — moving about
                           while nobody was touching it. */
                        <Field label="3D depth" hint={`${d.dssSeconds}s of history`}>
                            <Slider
                                value={d.dssSeconds}
                                min={MIN_SECONDS}
                                max={MAX_SECONDS}
                                onChange={(v) => d.set({ dssSeconds: v })}
                            />
                        </Field>
                    )}
                    <Field label="Waterfall speed" hint={`${d.waterfallRate} rows/s`}>
                        <Slider value={d.waterfallRate} min={2} max={40} onChange={(v) => d.set({ waterfallRate: v })} />
                    </Field>

                    <Field label="Row height" hint={`${d.rowHeight} px`}>
                        <Slider value={d.rowHeight} min={1} max={4} onChange={(v) => d.set({ rowHeight: v })} />
                    </Field>

                    <Field
                        label="History when panning"
                        hint={d.waterfallPan === 'follow'
                            ? 'moves with the axis; new ground is black'
                            : 'stays where it was drawn'}
                    >
                        <Segmented
                            value={d.waterfallPan || 'hold'}
                            onChange={(v) => d.set({ waterfallPan: v })}
                            options={[
                                {
                                    value: 'hold',
                                    label: 'Hold',
                                    title: 'Rows stay where they were painted. Nothing is lost, but after a pan the old rows no longer line up with the frequency scale',
                                },
                                {
                                    value: 'follow',
                                    label: 'Follow',
                                    title: 'History moves with the frequency scale, so a signal keeps its column. Parts of the band that were off screen have no history and come in black',
                                },
                            ]}
                        />
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

                    {/* Only where the operator has not already switched it off
                        for everybody: with station_id_overlay unset in the
                        receiver's ui-config there is nothing to show, and a
                        switch that changes nothing is worse than no switch.

                        In the split-view block because that is the only view it
                        is drawn in — the overlay sits in the spectrum pane, and
                        the other two modes do not have one. */}
                    {d.server.stationIdOverlay && (
                        <Field label="Receiver info" inline>
                            <Switch
                                checked={d.stationInfo !== false}
                                onChange={(v) => d.set({ stationInfo: v })}
                                title="The receiver's name, location and conditions in the top right of the spectrum. Off gives those pixels back to the waterfall"
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

            {/* The readout that says what the numbers below are doing. In this
                section rather than with the display settings because it is about
                the link and the load, which is what the rest of Data is about —
                and because the two are usually reached for together: you turn the
                stats on, see what the spectrum is costing, and then decide what to
                do about it with the controls underneath. */}
            {/* A dropdown, as the two settings under it are: three choices where
                one of them is "none" is a list, and Off/Left/Right as a segmented
                control would read as three things you might turn on rather than
                one setting with a corner attached. */}
            <Field
                label="Stats overlay"
                hint={d.spectrumStats == null ? 'default for this device' : undefined}
            >
                <select
                    className="select"
                    value={statsPlace(d.spectrumStats, mobile)}
                    onChange={(e) => d.set({ spectrumStats: e.target.value })}
                >
                    <option value="off">None</option>
                    <option value="left">Bottom left</option>
                    <option value="right">Bottom right</option>
                </select>
            </Field>
            {/* Beside the stats for the same reason they are beside the spectrum
                controls: both are readouts laid over the trace rather than settings
                that change what is drawn. A count rather than a switch, because "how
                many" is the only question — one marker on a quiet band and a dozen on
                a busy one are both reasonable, and there is no sensible default number
                to switch on to. */}
            <Field label="Peak markers" hint="spectrum only">
                <select
                    className="select"
                    value={peakCount(d.peakMarks)}
                    onChange={(e) => d.set({ peakMarks: Number(e.target.value) })}
                >
                    {PEAK_COUNTS.map((n) => (
                        <option key={n} value={n}>
                            {n === 0 ? 'None' : n === 1 ? 'Strongest only' : `${n} strongest`}
                        </option>
                    ))}
                </select>
            </Field>
            {/* Only with markers on: a threshold for something that is not being drawn
                is a control with nothing to do. */}
            {peakCount(d.peakMarks) > 0 && (
                <Field label="Peak marks" hint="where they sit">
                    <select
                        className="select"
                        value={peakPlace(d.peakMarksAt)}
                        onChange={(e) => d.set({ peakMarksAt: e.target.value })}
                    >
                        <option value="top">In a row at the top</option>
                        <option value="signal">On the signal</option>
                    </select>
                </Field>
            )}
            {peakCount(d.peakMarks) > 0 && (
                <Field label="Peak threshold" hint="above the noise floor">
                    <select
                        className="select"
                        value={peakSnr(d.peakMinSnr)}
                        onChange={(e) => d.set({ peakMinSnr: Number(e.target.value) })}
                    >
                        {PEAK_SNR_CHOICES.map((db) => (
                            <option key={db} value={db}>{db} dB</option>
                        ))}
                    </select>
                </Field>
            )}
            {/* A list, not a switch: "how long am I prepared to be counted as
                away" is the actual question, and the old switch answered it with
                a number the panel could only describe. `null` is not an option
                of its own — it resolves to this device's default and shows as
                that, so the control always reads as the delay in force.

                A dropdown rather than a row of chips: five options is more than
                a segmented control holds at this width without abbreviating them
                to "2m", and a delay is a thing you set once and forget rather
                than something worth a permanent row. */}
            <Field
                label="Slow down when idle"
                hint={d.idleThrottleMin == null ? 'default for this device' : undefined}
            >
                <select
                    className="select"
                    value={String(throttleMinutes(d.idleThrottleMin, mobile))}
                    onChange={(e) => d.set({ idleThrottleMin: Number(e.target.value) })}
                >
                    {THROTTLE_CHOICES.map((m) => (
                        <option key={m} value={String(m)}>
                            {m === 0 ? 'Never' : `After ${m} minutes`}
                        </option>
                    ))}
                </select>
            </Field>
            <div className="note note--tight">
                Asks the server to poll the spectrum at half rate after this long with no
                input, and restores it on the first move, key or tap. Defaults
                to {THROTTLE_MIN_DESKTOP} minutes, {THROTTLE_MIN_MOBILE} on a phone.
            </div>

            {/* The bigger version of the same idea, and a separate setting
                because it is a separate bargain: this one stops the display being
                live. Under the throttle, in the order they happen. */}
            <Field
                label="Pause when idle"
                hint={d.idlePauseMin == null ? 'default for this device' : undefined}
            >
                <select
                    className="select"
                    value={String(pauseMinutes(d.idlePauseMin, mobile))}
                    onChange={(e) => d.set({ idlePauseMin: Number(e.target.value) })}
                >
                    {PAUSE_CHOICES.map((m) => (
                        <option key={m} value={String(m)}>
                            {m === 0 ? 'Never' : `After ${m} minutes`}
                        </option>
                    ))}
                </select>
            </Field>
            <div className="note note--tight">
                Closes the spectrum connection altogether after this long with no input,
                leaving the last frame on screen with a Resume button over it. Nothing
                else stops — the audio carries on, and the receiver keeps its slot. Never
                on a desktop; {PAUSE_MIN_MOBILE} minutes on a phone, where the data and
                the battery are worth more than a waterfall nobody is watching.
            </div>

            <RenderDebug />

            <div className="row-end">
                <Button size="sm" variant="ghost" icon={<Icon.Reset />} onClick={d.reset}>Reset display</Button>
            </div>
        </div>
    );
}

// The interface's own colours: what it highlights in, what it writes in, and the
// two quieter greys under that — the labels, the units, the clocks.
//
// The same block the marker colours use, and deliberately: a row per colour, the
// picker opening on what is actually on screen, and a Default beside it. Nobody
// should have to learn a second way to change a colour in the same panel.
//
// Four rows rather than one, because they are four different jobs. Somebody
// wanting an amber receiver wants the accent; somebody who finds the labels too
// faint at night wants the greys and nothing else. Left alone, the greys follow
// the text colour, so changing one thing still looks deliberate — see
// lib/uiColors.js.
//
// The contrast figure is there because it is the one thing the OS colour picker
// cannot show: it knows nothing about the page the colour will sit on. It appears
// only against a colour somebody chose, and only when that colour is too close to
// the page to read — see contrastMin.
function UiColors() {
    const d = useDisplay();
    const theme = d.theme === 'light' ? 'light' : 'dark';
    const mine = d.uiColors || {};
    // The receiver info's row needs the operator's colour too: unset, that is
    // what the overlay is actually drawn in.
    const now = effectiveColors(mine, theme, d.server.stationIdColor);
    const on = matchUiTheme(mine);

    // A preset writes its colours into the same four settings the rows below
    // edit, and switches to the theme it was drawn for — amber on white is a
    // highlighter. The default carries no theme and leaves that alone: it is the
    // theme's own colours, whichever theme is in force.
    const apply = (preset) => d.set({
        uiColors: uiColorsFrom(preset),
        ...(preset.theme ? { theme: preset.theme } : {}),
    });

    const row = (which, name, hint) => {
        // The receiver info is drawn on the waterfall, not on the page, and the
        // waterfall is dark in both themes — measuring it against the page would
        // pass a dark colour that is invisible where it actually goes.
        const ratio = which === 'station'
            ? canvasContrast(now[which], theme)
            : pageContrast(now[which], theme);
        // Only about a colour somebody chose. The stock light-theme accent is
        // 3.97:1 against its own page, so measuring the defaults would open the
        // panel by warning about the receiver's own design.
        const poor = !!mine[which] && ratio != null && ratio < contrastMin(which);
        return (
            <label className="markcolors__row">
                <span className="markcolors__name" title={hint}>{name}</span>
                {/* Only when it is bad news: a ratio beside every row would be a
                    readout, and this is a warning. */}
                {poor && (
                    <span
                        className="markcolors__warn"
                        title={`${ratio.toFixed(1)}:1 against the page — under ${contrastMin(which)}:1, which is where this text stops being comfortably legible`}
                    >
                        {ratio.toFixed(1)}:1
                    </span>
                )}
                <ColorPicker
                    value={now[which]}
                    inherited={!mine[which]}
                    onChange={(v) => d.setUiColor(which, v)}
                    onClear={() => d.setUiColor(which, '')}
                    clearLabel="Default"
                    ariaLabel={name}
                    title={hint}
                />
            </label>
        );
    };

    return (
        <>
            {/* A swatch and a name, not a tile painted in the scheme: a colour
                scheme is recognised on sight and cannot be pictured from a word,
                but the first attempt at this drew each button in its own page
                colour — and every dark scheme's page is near-black, so seven of
                them came out as seven black rectangles telling you nothing. On
                the light theme they read as holes in the panel.

                So the button is an ordinary button, in whatever scheme is running
                now, and the scheme it offers is in the swatch: its page, with its
                accent and its text on top. Three colours at a size you can
                compare, instead of one at a size you cannot. */}
            <Field label="Colour scheme" hint={on ? undefined : 'custom'}>
                <div className="palette-grid uitheme-grid">
                    {UI_THEMES.map((preset) => {
                        const sw = themeSwatch(preset);
                        return (
                            <button
                                key={preset.id}
                                type="button"
                                className={`uitheme${on === preset.id ? ' is-active' : ''}`}
                                title={`${preset.name} — ${preset.note}`}
                                aria-pressed={on === preset.id}
                                onClick={() => apply(preset)}
                            >
                                <span className="uitheme__sw" style={{ background: sw.bg }}>
                                    <i style={{ background: sw.accent }} />
                                    <i style={{ background: sw.text }} />
                                </span>
                                <span className="uitheme__name">{preset.name}</span>
                            </button>
                        );
                    })}
                </div>
            </Field>

            <Field label="Colours">
            <div className="markcolors">
                {row('accent', 'Accent', 'Everything the interface highlights: the tuned frequency, the selected mode, the dial line on the spectrum, focus rings. What goes on top of it is worked out from it')}
                {row('text', 'Text', 'The main text colour. The two greys below follow it unless they have been set themselves')}
                {row('dim', 'Dim', 'Secondary text — field labels, units, the clocks')}
                {row('faint', 'Faint', 'The quietest text: placeholders, disabled controls, empty panels')}
                {row('station', 'Receiver info', 'The receiver\'s name and location over the spectrum. Unset it follows the operator\'s own colour, or the text colour where that reads on a waterfall')}
            </div>
            </Field>
        </>
    );
}

// Frames a second the spectrum loop may run at. Nothing above 60: the point of
// a cap is to be under the display's rate, and on a 60 Hz panel every larger
// number is the same number.
const FPS_CHOICES = [0, 60, 30, 20, 15, 10];

// How many device pixels the canvases are rendered at, as a fraction.
const SCALE_CHOICES = [1, 0.75, 0.5, 0.35];

/**
 * The bisect kit for "this page is using a lot of GPU".
 *
 * Hidden behind its own switch, and everything under it inert while that switch
 * is off — see the note in DisplayContext's DEFAULTS. It is here rather than in
 * a build flag or the console because the machines where this matters are other
 * people's, and the measurement that settles it is the operator watching their
 * own GPU figure while one thing at a time is taken away.
 *
 * The order is the order worth trying them in: the two waterfall layers first,
 * since removing the waterfall from the DOM entirely is what produced the
 * largest reading, and the frame rate last, since stopping every draw in the
 * app produced one of the smallest. Each switch leaves the display otherwise
 * running, so what changes is one suspect and not the workload.
 */
function RenderDebug() {
    const d = useDisplay();
    if (!d.debug) {
        return (
            <>
                <div className="section-label"><span>Debug</span></div>
                <Field label="Rendering tools" inline>
                    <Switch
                        checked={false}
                        onChange={() => d.set({ debug: true })}
                        title="Switches for weighing what the display costs the GPU. Nothing here changes what is received or decoded — only how it is put on screen"
                    />
                </Field>
            </>
        );
    }

    return (
        <>
            <div className="section-label">
                <span>Debug</span>
                <span className="section-label__note">rendering cost</span>
            </div>
            <Field label="Rendering tools" inline>
                <Switch
                    checked
                    onChange={() => d.set({ debug: false })}
                    title="Hide these and put every one of them back, whatever it is set to"
                />
            </Field>
            <div className="note note--tight">
                Take one thing away at a time and watch the GPU figure. Nothing here
                touches the receiver — only how the display is put on screen — and
                turning the section off restores all of it.
            </div>

            {/* First, because it is two layers rather than one: the marks canvas
                sits on top of this one and is promoted along with it. */}
            <Field label="Waterfall layer" inline>
                <Switch
                    checked={d.dbgWfLayer !== false}
                    onChange={(v) => d.set({ dbgWfLayer: v })}
                    title="Off: the waterfall canvas stops being kept as a GPU texture of its own. It still draws exactly as before — but it is painted with the page instead of being re-blended over it on every frame, and the marks canvas above it loses its own layer too. Costs a little smoothness in the row slide"
                />
            </Field>
            <Field label="Waterfall marks" inline>
                <Switch
                    checked={d.dbgWfMarks !== false}
                    onChange={(v) => d.set({ dbgWfMarks: v })}
                    title="Off: the dial and passband lines over the waterfall are hidden. They are still drawn — this takes away the layer, not the work — which is what tells the two apart"
                />
            </Field>
            <Field label="Top bar and pad layers" inline>
                <Switch
                    checked={d.dbgUiLayers !== false}
                    onChange={(v) => d.set({ dbgUiLayers: v })}
                    title="Off: the top bar, the frequency barrel and the band panel's waterfall stop being kept as textures of their own. These were promoted to stop a live meter repainting the whole window, so this one can go either way — that is why it is worth measuring"
                />
            </Field>

            <Field label="Render scale" hint={d.dbgRenderScale === 1 ? undefined : 'softer'}>
                <select
                    className="select"
                    value={String(d.dbgRenderScale || 1)}
                    onChange={(e) => d.set({ dbgRenderScale: Number(e.target.value) })}
                >
                    {SCALE_CHOICES.map((s) => (
                        <option key={s} value={String(s)}>
                            {s === 1 ? 'Full (sharp)' : `${Math.round(s * 100)} %`}
                        </option>
                    ))}
                </select>
            </Field>
            <div className="note note--tight">
                How many device pixels the spectrum is drawn at. This is the control
                that tells the two kinds of cost apart: it cuts texture memory and
                upload sharply, but a layer at half scale still covers the same
                screen, so it should barely move a bill that is per-composited-frame.
                If it does move it, the cost is the drawing after all.
            </div>

            <Field label="Frame rate" hint={d.dbgMaxFps > 0 ? `${d.dbgMaxFps}/s` : undefined}>
                <select
                    className="select"
                    value={String(d.dbgMaxFps || 0)}
                    onChange={(e) => d.set({ dbgMaxFps: Number(e.target.value) })}
                >
                    {FPS_CHOICES.map((f) => (
                        <option key={f} value={String(f)}>
                            {f === 0 ? 'Display rate' : `${f} a second`}
                        </option>
                    ))}
                </select>
            </Field>
            <div className="note note--tight">
                Caps the spectrum's draw loop, and between ticks asks the browser for
                no frame at all — so a capped display is not merely drawing less, it
                has stopped asking to be animated. The stats overlay's FPS line reads
                the same loop, so it shows whether the cap is in force. Below about 15
                the waterfall starts dropping rows.
            </div>
        </>
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
