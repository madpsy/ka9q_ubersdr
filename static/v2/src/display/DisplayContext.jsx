// Everything about how the spectrum and waterfall *look*, kept separate from
// the radio state so a display tweak never touches the signal path (and so the
// canvas can read a single object out of a ref).

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from '../react.js';
import { UI_CONFIG_DEFAULTS, parseUiConfig } from './uiConfig.js';

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
    waterfallRate: 20,      // committed rows per second
    rowHeight: 2,           // device px per row
    // Slide each new row into view over the gap until the next one, instead of
    // letting it appear in a single frame. It costs nothing per frame — the
    // slide is a composited transform, and the canvas is still painted once per
    // row — but it is a switch because the browser resamples the picture while
    // it is in flight, which is very slightly soft on a non-HiDPI screen.
    smoothScroll: true,
    markerBands: true,      // band allocations in the marker bar
    markerBookmarks: true,       // bookmark pills the receiver publishes
    markerLocalBookmarks: true,  // bookmark pills saved in this browser
    markerVoice: true,           // detected voice activity (only where the receiver has it)
    // Spot markers, per feed and only where the instance has it. Digital spots
    // are deliberately absent: a decoder band puts every station on one
    // frequency, so they would stack into a single illegible pile rather than
    // showing you where to tune.
    markerDxSpots: true,
    markerCwSpots: true,
    viewMode: 'split',      // 'split' | 'spectrum' | 'waterfall'
    split: 0.25,            // fraction of the centre area used by the spectrum
                            // (only consulted in 'split' mode)
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
    idleThrottle: true,
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
    uiScale: 1,             // multiplier on every font-size (top bar A-/A+)
};

// Text-size range and step for the top bar's zoom buttons.
export const UI_SCALE_MIN = 0.75;
export const UI_SCALE_MAX = 1.6;
export const UI_SCALE_STEP = 0.05;

// Bumped when a stored value has to be reinterpreted rather than merely added
// to. Everything in this file is persisted, defaults included — the save effect
// writes the whole object on mount — so a stored value cannot be assumed to be
// a choice somebody made, and a new default reaches nobody without this.
const SETTINGS_VERSION = 2;

function migrate(saved) {
    // v2: zoomAnchor gained 'auto', which is tuned on a phone.
    //
    // A stored 'cursor' from before this is the old default written out on
    // first load, not a preference — and on a phone it cannot have been one at
    // all, because the pinch ignored this setting entirely until now, so there
    // was nothing to choose between. Dropping it lets 'auto' apply. An explicit
    // 'tuned' is left alone: that one could only have been set on purpose.
    if (!(saved.v >= 2) && saved.zoomAnchor === 'cursor') delete saved.zoomAnchor;
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

    const value = useMemo(() => ({ ...state, server, set, reset }), [state, server, set, reset]);
    return <DisplayContext.Provider value={value}>{children}</DisplayContext.Provider>;
}

export function useDisplay() {
    const ctx = useContext(DisplayContext);
    if (!ctx) throw new Error('useDisplay outside DisplayProvider');
    return ctx;
}
