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
    floorDb: -110,
    ceilDb: -40,
    smoothing: 0.5,         // 0 = off, ->1 = heavier temporal averaging
    fill: true,             // shade the area under the spectrum trace
    peakHold: false,
    peakDecay: 3,           // dB per second; 0 = hold indefinitely
    grid: false,
    waterfallRate: 20,      // committed rows per second
    rowHeight: 1,           // device px per row
    viewMode: 'split',      // 'split' | 'spectrum' | 'waterfall'
    split: 0.42,            // fraction of the centre area used by the spectrum
                            // (only consulted in 'split' mode)
    snapHz: 1,              // click-to-tune rounding
    theme: 'dark',
};

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
