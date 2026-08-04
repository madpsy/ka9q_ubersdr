// Everything about how the spectrum and waterfall *look*, kept separate from
// the radio state so a display tweak never touches the signal path (and so the
// canvas can read a single object out of a ref).

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from '../react.js';
import { UI_CONFIG_DEFAULTS, parseUiConfig } from './uiConfig.js';

const STORAGE_KEY = 'ubersdr.v2.display';

export const DEFAULTS = {
    palette: 'turbo',
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
    rowHeight: 1,           // device px per row
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
    split: 0.42,            // fraction of the centre area used by the spectrum
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
    chatUsersWidth: 170,    // px given to the chat user list, drag to change
    scopeView: 'both',      // audio scope panel: 'both' | 'scope' | 'waterfall'
    scopeFft: 4096,         // analyser FFT size while that panel is open
    scopeTimebase: 20,      // ms across the oscilloscope
    scopeContrast: 1.0,     // gamma on the audio waterfall's colour mapping
    // Signal panel meters: 'bar' or the analogue 'needle'. Clicking a meter
    // switches both — see SignalPanel.
    meterStyle: 'bar',
    theme: 'dark',
    uiScale: 1,             // multiplier on every font-size (top bar A-/A+)
};

// Text-size range and step for the top bar's zoom buttons.
export const UI_SCALE_MIN = 0.75;
export const UI_SCALE_MAX = 1.6;
export const UI_SCALE_STEP = 0.05;

function load() {
    try {
        return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}) };
    } catch (e) {
        return { ...DEFAULTS };
    }
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
    const reset = useCallback(() => setState({ ...DEFAULTS }), []);

    const value = useMemo(() => ({ ...state, server, set, reset }), [state, server, set, reset]);
    return <DisplayContext.Provider value={value}>{children}</DisplayContext.Provider>;
}

export function useDisplay() {
    const ctx = useContext(DisplayContext);
    if (!ctx) throw new Error('useDisplay outside DisplayProvider');
    return ctx;
}
