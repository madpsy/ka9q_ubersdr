// Everything about how the spectrum and waterfall *look*, kept separate from
// the radio state so a display tweak never touches the signal path (and so the
// canvas can read a single object out of a ref).

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from '../react.js';
import { UI_CONFIG_DEFAULTS, parseUiConfig } from './uiConfig.js';
import { UI_COLOR_VARS, uiColorVars } from '../lib/uiColors.js';
import { invalidateThemeColors } from '../lib/spectrumTrace.js';

const STORAGE_KEY = 'ubersdr.v2.display';

export const DEFAULTS = {
    // The first-run palette. Classic over turbo: black-blue-cyan-yellow-white
    // is what an SDR waterfall has looked like since the first ones, so it is
    // the one people arrive already able to read. A stored choice wins — see
    // load() — so this only decides what a new visitor gets.
    palette: 'classic',
    contrast: 1.0,          // gamma applied to the waterfall colour mapping
    autoRange: true,
    // Minimum dynamic range in auto-level mode, dB. null follows the operator's
    // `min_span` from /api/ui-config; 0 means no minimum ("Auto"), as in v1.
    autoMinSpan: null,
    floorDb: -110,
    ceilDb: -40,
    smoothing: 0.5,         // 0 = off, ->1 = heavier temporal averaging
    fill: true,             // solid area under the spectrum trace
    peakHold: false,
    peakDecay: 6,           // dB per second; 0 = hold indefinitely
    grid: false,
    // The receiver's name, location and conditions, drawn in the top right of the
    // spectrum — see drawStationId. On, because it is what says whose receiver
    // this is, and a screenshot without it is a waterfall from nowhere.
    //
    // The operator can switch it off for everybody (station_id_overlay in the
    // server's ui-config); this is the listener's half of the same question, for
    // somebody who would rather have those pixels of spectrum back. Neither
    // overrides the other — off at either end is off.
    stationInfo: true,
    waterfallRate: 20,      // committed rows per second
    rowHeight: 2,           // device px per row
    // Slide each new row into view over the gap until the next one, instead of
    // letting it appear in a single frame. It costs nothing per frame — the
    // slide is a composited transform, and the canvas is still painted once per
    // row — but it is a switch because the browser resamples the picture while
    // it is in flight, which is very slightly soft on a non-HiDPI screen.
    smoothScroll: true,
    // What the waterfall's history does when the view moves under it.
    //
    //   'hold'   — the rows stay where they were painted. A signal's trail
    //              keeps the shape it had, and after a pan the old rows no
    //              longer line up with the frequency axis: a carrier steps
    //              sideways at the moment of the pan and its history reads at
    //              the wrong frequency. This is what every waterfall of this
    //              kind has always done, and it is the default because nothing
    //              is ever thrown away.
    //   'follow' — the history is shifted with the axis, so a signal stays in
    //              its own column and the whole picture keeps meaning one
    //              frequency scale. What moves in from the edge is black,
    //              because there is no history for a part of the band that was
    //              not on screen.
    waterfallPan: 'hold',
    markerBands: true,      // band allocations in the marker bar
    markerBookmarks: true,       // bookmark pills the receiver publishes
    markerLocalBookmarks: true,  // bookmark pills saved in this browser
    markerVoice: true,           // detected voice activity (only where the receiver has it)
    // Callsigns the voice skimmer has heard and validated — the addon's Confirmed
    // column, on the bar. A different question from markerVoice above: that one is
    // "speech was heard here in the last ninety seconds", this one is "this station
    // identified itself". Only where the voiceskimmer addon is installed.
    markerVoiceConfirmed: true,
    // The other VFOs — where A, B, C and D are parked. Not the one you are on:
    // that is the dial, and the spectrum already marks it.
    markerVfos: true,
    // Packet channels, from the packet addon: a pill per configured channel carrying
    // the stations heard on it. Only where the addon is installed. Unlike every other
    // marker this one is a *shared* frequency rather than one station, which is why its
    // tooltip is a list — see packetTip in MarkerBar.
    markerPacket: true,
    // Spot markers, per feed and only where the instance has it. Digital spots
    // are deliberately absent: a decoder band puts every station on one
    // frequency, so they would stack into a single illegible pile rather than
    // showing you where to tune.
    markerDxSpots: true,
    markerCwSpots: true,
    viewMode: 'split',      // 'split' | 'spectrum' | 'waterfall'
    split: 0.25,            // fraction of the centre area used by the spectrum
                            // (only consulted in 'split' mode)
    // Whether the frequency scale doubles as a splitter that can be dragged.
    //
    // On by default, because grabbing the join is how you would expect to move
    // it and the slider is two panels away. Off for the operator who keeps
    // catching it: the scale is also the strip you point at to read a frequency
    // off, and on a touchscreen a finger that meant to do that and moved four
    // pixels has re-shared the display instead. Only the drag goes — the slider
    // and the double-click reset both still work, so nothing becomes unreachable.
    splitDrag: true,
    // Resting opacity of floating panel windows, 0.5..1 from the Layout panel.
    // 1 is solid, i.e. the effect off.
    floatOpacity: 0.8,
    // The Receiver panel's step size, shared so click-to-tune on the spectrum
    // lands on the same grid as the +/- buttons. 500 Hz suits SSB, which is
    // what most of this band is.
    tuneStep: 500,
    // What the wheel does over the spectrum: 'zoom' or 'tune' by tuneStep.
    wheelAction: 'zoom',
    // What a zoom holds still: 'cursor' keeps the frequency under the pointer
    // or the fingers where it is, 'tuned' re-centres on the dial each step
    // (which is what the toolbar's +/- buttons do). Read by the wheel and by
    // the spectrum's pinch; only consulted when wheelAction is 'zoom'.
    //
    // 'auto' is the default and means cursor on a pointer, tuned on a phone —
    // see resolveZoomAnchor. The two devices genuinely want opposite things.
    // A wheel is precise and sits over the signal you are already pointing at,
    // so holding that still is exactly right. A pinch is two fat fingers whose
    // midpoint is wherever they happened to land, on a screen where the dial is
    // the only thing you are actually interested in — anchoring on the fingers
    // there walks the view off the signal you were listening to.
    zoomAnchor: 'auto',
    // Halve the spectrum poll rate after a few minutes with no input, and put
    // it back on the first sign of life (IdleWatch). On by default, as it is in
    // v1, because the data it saves is data nobody was looking at — but it is a
    // switch because "nobody is looking" is a guess, and someone watching a
    // band for a signal to appear is not idle in the sense that matters.
    // Hovering a collapsed dock's rail slides it out over the centre, the way
    // an auto-hidden taskbar does. On by default: the docks that ship collapsed
    // are otherwise a click each to look into and a click each to put back.
    //
    // A peek never becomes the stored state — see Dock — so this changes what
    // hovering does and nothing about what a click means.
    hoverPanels: true,
    // Minutes of nothing happening before the spectrum drops to half rate, one
    // of THROTTLE_CHOICES in radio/idle.js. 0 is never.
    //
    // null means "not chosen" and resolves per device — sooner on a phone, where
    // the connection is likelier to be metered — which is the only way one
    // stored value can mean the right thing on both. See throttleMinutes.
    idleThrottleMin: null,
    // Minutes of nothing happening before the spectrum socket is closed
    // altogether, one of PAUSE_CHOICES. 0 is never, and on a desktop that is what
    // "not chosen" resolves to — see pauseMinutes. Unlike the throttle this does
    // not undo itself on the next mousemove: the display says it is paused and
    // waits to be asked, because a socket reopening because somebody walked past
    // the desk is the saving thrown away.
    idlePauseMin: null,
    // The diagnostic readout over the waterfall: 'off', 'left' or 'right'.
    //
    // null means "not chosen" and resolves per device, the same shape as the two
    // idle delays above: bottom left on a desktop, off on a phone. A desktop has
    // the room and the operator is usually sitting in front of the receiver
    // working out why something looks wrong; a phone has neither the pixels nor
    // the corner to spare — the pad, the sheet and the chips are all down there —
    // and one of the figures is the address you are connecting from, which is not
    // something to have on screen by default on a device used in public.
    //
    // See statsPlace, and lib/spectrumStats.js for what it shows.
    spectrumStats: null,
    // How many peak markers to point at the strongest signals in the view. Off, because
    // the trace already shows where the signals are and this is for when you want them
    // named — a spectrum that arrives covered in labels has decided that for you.
    // Spectrum pane only: see lib/spectrumPeaks.js and drawPeakMarks in SpectrumView.
    peakMarks: 0,
    // How far above the noise floor a signal has to be, in dB, to earn one of those
    // markers — named to differ from the peakSnr clamp it is passed through, since a
    // bare key here reads exactly like a use of that function. The count above is
    // therefore a ceiling and not a quota: on a quiet band
    // this is what leaves the spectrum clear instead of filling it with markers on
    // noise. Ten decibels is a signal you can hear. See lib/spectrumPeaks.js.
    peakMinSnr: 10,
    // Whether those markers sit in a row along the top of the pane with a hairline down
    // to each signal ('top', the default, because a row of labels at one height reads as
    // a list and never covers a peak) or ride the trace on their own peaks ('signal').
    // See PEAK_PLACES; the key is named apart from the peakPlace clamp for the reason
    // given above.
    peakMarksAt: 'top',
    // Phone only: whether the row of panel names stays on screen while a sheet is open.
    //
    // False is how the shell has always worked, and it is the right default — see the
    // note at the top of MobileShell. The row is about a tenth of a handset's height, a
    // sheet needs every pixel it can get, and switching panels is close-then-open rather
    // than one tap. True is for somebody who moves between panels constantly and would
    // rather pay that tenth than press × each time.
    mobileTabsAlways: false,
    // Whether the Quick bands panel paints its amateur band keys with the FT8
    // conditions (see bandTone). On, because that colouring is most of why the
    // panel is worth a glance — but a receiver used for one band, or an operator
    // who reads the conditions from the space weather table and finds a wall of
    // green and amber noisy, can have the keys plain.
    //
    // The Multipad's band row keeps its colours either way: the toggle is in the
    // Quick bands panel, and a switch in one panel silently restyling another is
    // worse than the two disagreeing. On a phone the colour is also the whole
    // reason that row is there.
    bandColours: true,
    scopeView: 'both',      // audio scope panel: 'both' | 'scope' | 'waterfall'
    scopeFft: 4096,         // analyser FFT size while that panel is open
    scopeTimebase: 20,      // ms across the oscilloscope
    scopeContrast: 1.0,     // gamma on the audio waterfall's colour mapping
    // Signal panel meters: 'bar' or the analogue 'needle'. Clicking a meter
    // switches both — see SignalPanel.
    meterStyle: 'bar',
    // Which reading the top bar's meter shows: 'signal' (the S-meter, in dBFS)
    // or 'snr'. Clicking the meter swaps it. Signal by default because it is
    // the one that answers "is anything there".
    topMeter: 'signal',
    theme: 'dark',
    // The interface's own colours: the accent everything is highlighted in, the
    // text, and the two quieter greys under it — labels, units, the clocks.
    //
    // Each is null until chosen, and null means the theme's own value rather than
    // a colour written out here: that is what keeps "I have changed nothing"
    // meaning nothing has changed, on a theme this build has not thought of as
    // much as on the two it has. A chosen colour applies to both themes, because
    // somebody who picked amber picked amber, not amber-when-dark.
    //
    // The greys follow the text unless chosen themselves, and `station` — the
    // receiver's name over the spectrum — follows the operator's own colour
    // before either. See lib/uiColors.js, which also derives what goes on top of
    // an accent fill.
    uiColors: {
        accent: null, text: null, dim: null, faint: null, station: null,
    },
    uiScale: 1,             // multiplier on every font-size (top bar A-/A+)
    // Vibration on touch: 'off' | 'light' | 'medium' | 'strong'. On by default,
    // because a phone's controls have no travel and nothing else says a tap
    // landed — see lib/haptics.js. It costs nothing where there is no vibrator:
    // every device with a pointer rather than a finger fails hapticsSupported()
    // and never fires, which is also why the Display panel hides these controls
    // there rather than offering settings with no effect.
    haptics: 'medium',
    // …and what it applies to. Two switches rather than one because they answer
    // different questions: hapticButtons is confirmation of something you did
    // to a control you were looking at, hapticSpectrum is the waterfall telling
    // you a tap tuned, a pinch took a step or a drag grabbed a filter edge —
    // results that land somewhere other than under your finger. Wanting one
    // without the other is a normal preference, not an edge case.
    hapticButtons: true,
    hapticSpectrum: true,
    // Overrides for the dial line and the passband edges, *per palette*:
    //
    //     { classic: { dial: '#ff2ec4', edge: '#5cff8f' }, … }
    //
    // Absent means "follow the palette", which is what almost everyone should
    // leave them on: a marker has to contrast with a colour map that covers a
    // whole hue arc, and paletteMarks() in lib/palettes.js picks hues each map
    // never reaches. But colour vision and screens vary in exactly the way a
    // fixed pair of hues cannot accommodate, which is why this is a setting and
    // not just a better default.
    //
    // Keyed by palette rather than held as one pair, because the question the
    // setting answers is "what shows up against *this* colour map" — a magenta
    // dial chosen to beat the classic waterfall's blues is the worst possible
    // choice over magma, so one global override would have to be re-picked on
    // every palette change. Switching palettes now brings back whatever was
    // chosen for it last time.
    markOverrides: {},
};

// Text-size range and step for the top bar's zoom buttons.
export const UI_SCALE_MIN = 0.75;
export const UI_SCALE_MAX = 1.6;
export const UI_SCALE_STEP = 0.05;

// Bumped when a stored value has to be reinterpreted rather than merely added
// to. Everything in this file is persisted, defaults included — the save effect
// writes the whole object on mount — so a stored value cannot be assumed to be
// a choice somebody made, and a new default reaches nobody without this.
const SETTINGS_VERSION = 4;



function migrate(saved) {
    // v2: zoomAnchor gained 'auto', which is tuned on a phone.
    //
    // A stored 'cursor' from before this is the old default written out on
    // first load, not a preference — and on a phone it cannot have been one at
    // all, because the pinch ignored this setting entirely until now, so there
    // was nothing to choose between. Dropping it lets 'auto' apply. An explicit
    // 'tuned' is left alone: that one could only have been set on purpose.
    if (!(saved.v >= 2) && saved.zoomAnchor === 'cursor') delete saved.zoomAnchor;

    // v3: the idle throttle became a delay rather than a switch.
    //
    // Off is the one thing the old switch could say that the new list still
    // says, so it carries over as "never" — and it is the only value worth
    // carrying: `true` was the default written out on first load and says
    // nothing about how long anybody wanted to wait, which is the question the
    // list asks. Those become null and take the device's default.
    if (!(saved.v >= 3)) {
        if (saved.idleThrottle === false) saved.idleThrottleMin = 0;
        delete saved.idleThrottle;
    }

    // v4: the stats overlay's default became per-device rather than flat 'off'.
    //
    // A stored 'off' from before this is the old default written out on first
    // load — every setting is persisted whole, so everyone has one — and it would
    // hold the new default off for ever on machines that should now have it. Any
    // other stored value is a corner somebody picked and is left alone.
    if (!(saved.v >= 4) && saved.spectrumStats === 'off') delete saved.spectrumStats;

    return saved;
}

function load() {
    try {
        const saved = migrate(JSON.parse(localStorage.getItem(STORAGE_KEY)) || {});
        return { ...DEFAULTS, ...saved, v: SETTINGS_VERSION };
    } catch (e) {
        return { ...DEFAULTS, v: SETTINGS_VERSION };
    }
}

// Which anchor is in force. 'auto' is the default and splits by device: a phone
// gets the tuned frequency held still, anything with a pointer gets the cursor.
export function resolveZoomAnchor(value, mobile) {
    if (value === 'tuned' || value === 'cursor') return value;
    return mobile ? 'tuned' : 'cursor';
}

const DisplayContext = createContext(null);


export function DisplayProvider({ children }) {
    const [state, setState] = useState(load);
    const [server, setServer] = useState(UI_CONFIG_DEFAULTS);

    useEffect(() => {
        let cancelled = false;
        fetch('/api/ui-config')
            .then((r) => r.json())
            .then((cfg) => {
                if (!cancelled) setServer(parseUiConfig(cfg));
            })
            .catch(() => { /* non-fatal — the spectrum just has no backdrop */ });
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
    }, [state]);

    useEffect(() => {
        document.documentElement.dataset.theme = state.theme;
    }, [state.theme]);

    // The chosen colours, as properties on the root. Every property the group
    // owns is visited every time: one that is set gets written, one that is not
    // gets *removed*, which is what lets the stylesheet's own per-theme value
    // apply again rather than being overwritten with a copy of itself.
    //
    // Keyed on the theme as well: the ink that goes on top of an accent fill and
    // the alphas of its wash both differ between them.
    useEffect(() => {
        const root = document.documentElement.style;
        const vars = uiColorVars(state.uiColors, state.theme);
        for (const name of UI_COLOR_VARS) {
            if (vars[name]) root.setProperty(name, vars[name]);
            else root.removeProperty(name);
        }
        // The spectrum resolves its colours once per theme and caches them —
        // --accent among them, for the dial line — so a colour changed without
        // the theme changing would not reach the canvas until something else
        // did. See themeColors.
        invalidateThemeColors();
    }, [state.uiColors, state.theme]);

    // Exposed as a custom property rather than an inline style so every
    // floating window picks it up without re-rendering — the same approach v1
    // uses for its controls_opacity setting.
    // Clamped so a stale or bogus stored value can never hide the windows.
    useEffect(() => {
        const o = Number(state.floatOpacity);
        const eff = Number.isFinite(o) && o > 0 ? Math.min(1, Math.max(0.5, o)) : 1;
        document.documentElement.style.setProperty('--float-opacity', String(eff));
    }, [state.floatOpacity]);

    // Every font-size in styles.css is calc(Npx * var(--ui-scale)), so this one
    // property resizes all the text — including panels that are not mounted yet.
    useEffect(() => {
        document.documentElement.style.setProperty('--ui-scale', String(state.uiScale ?? 1));
    }, [state.uiScale]);

    const set = useCallback((patch) => setState((s) => ({ ...s, ...patch })), []);
    const reset = useCallback(() => setState({ ...DEFAULTS, v: SETTINGS_VERSION }), []);

    // One marker colour for one palette. `hex` empty puts that mark back on the
    // palette's own choice, and a palette left with neither override drops out
    // of the map entirely rather than sitting there as an empty object.
    const setMarkColor = useCallback((palette, which, hex) => setState((s) => {
        const all = s.markOverrides || {};
        const one = { ...(all[palette] || {}) };
        if (hex) one[which] = hex; else delete one[which];
        const next = { ...all };
        if (Object.keys(one).length) next[palette] = one; else delete next[palette];
        return { ...s, markOverrides: next };
    }), []);

    // One of the interface's own colours. `hex` empty puts it back on the theme's
    // — or, for the two greys, back on following the text colour.
    const setUiColor = useCallback((which, hex) => setState((s) => ({
        ...s,
        uiColors: { ...(s.uiColors || {}), [which]: hex || null },
    })), []);

    const value = useMemo(
        () => ({ ...state, server, set, reset, setMarkColor, setUiColor }),
        [state, server, set, reset, setMarkColor, setUiColor],
    );
    return <DisplayContext.Provider value={value}>{children}</DisplayContext.Provider>;
}

export function useDisplay() {
    const ctx = useContext(DisplayContext);
    if (!ctx) throw new Error('useDisplay outside DisplayProvider');
    return ctx;
}
