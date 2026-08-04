// Which extensions exist, which the operator has enabled, and which one is open.
//
// Two lists have to agree before an extension can be opened:
//
//   * what this build can render — extensions/registry.jsx;
//   * what the receiver has turned on — `/api/extensions`, which reads
//     extensions.yaml and answers { available: [{slug, displayName}], default }.
//
// The panel lists the first and marks each entry with whether the second has
// it, so an extension we support but the operator has not enabled reads as
// "not enabled here" rather than silently failing at attach time. The reverse
// case — enabled on the receiver but not written for v2 — is simply not shown:
// this is a launcher, and a row nothing can open is not a control.
//
// Exactly one extension is open at a time. That is not a UI preference: the
// server allows one audio extension per session and tears the previous one down
// when a second attaches, so anything else would show two windows where only
// one is decoding. Opening a second therefore closes the first.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from '../react.js';
import { EXTENSIONS, EXTENSION_BY_ID } from './registry.jsx';

const STORAGE_KEY = 'ubersdr.v2.extensions';

const ExtensionsContext = createContext(null);

function stored() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch (e) {
        return {};
    }
}

// Window geometry per extension, so reopening one puts it back where it was.
function loadGeometry() {
    const raw = stored();
    const out = {};
    for (const [id, g] of Object.entries(raw.floats || {})) {
        if (!EXTENSION_BY_ID[id] || !g) continue;
        out[id] = {
            x: Number(g.x) || 0,
            y: Number(g.y) || 0,
            w: Math.max(320, Number(g.w) || EXTENSION_BY_ID[id].float.w),
            h: Math.max(200, Number(g.h) || EXTENSION_BY_ID[id].float.h),
        };
    }
    return out;
}

// Which extensions are in their minimal view, kept per extension the way a
// panel's is — see `minimal` in ./registry.jsx. Remembered because it is a way
// of working rather than a momentary action: someone who wants the cut-down
// decoder wants it again tomorrow.
function loadMinimal() {
    const raw = stored();
    const out = {};
    for (const [id, on] of Object.entries(raw.minimal || {})) {
        if (EXTENSION_BY_ID[id] && EXTENSION_BY_ID[id].minimal && on) out[id] = true;
    }
    return out;
}

export function ExtensionsProvider({ children }) {
    // `null` until /api/extensions answers; an empty array afterwards means the
    // receiver really has none. The difference matters — "loading" and "none
    // enabled" must not read the same.
    const [enabled, setEnabled] = useState(null);
    const [activeId, setActiveId] = useState(null);
    // Minimised only hides the window. Unlike a panel, an extension is a live
    // decoder — unmounting it would drop the stream and the decodes with it —
    // so the window stays mounted and merely stops being drawn.
    //
    // Not to be confused with `minimal` below, which is the panels' cut-down
    // view: minimised is about the window, minimal is about what is inside it.
    const [minimised, setMinimised] = useState(false);
    const [floats, setFloats] = useState(loadGeometry);
    const [minimal, setMinimal] = useState(loadMinimal);

    useEffect(() => {
        let cancelled = false;
        fetch('/api/extensions')
            .then((r) => r.json())
            .then((d) => {
                if (cancelled) return;
                const list = Array.isArray(d && d.available) ? d.available : [];
                setEnabled(list.map((e) => String(e.slug || '')).filter(Boolean));
            })
            .catch(() => { if (!cancelled) setEnabled([]); });
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ floats, minimal })); } catch (e) { /* ignore */ }
    }, [floats, minimal]);

    // The registry, annotated. `enabled` is null while the fetch is in flight,
    // and nothing is openable until it is known.
    const list = useMemo(() => EXTENSIONS.map((e) => ({
        ...e,
        enabled: enabled == null ? false : enabled.includes(e.id),
    })), [enabled]);

    // Opening always shows the window: asking for an extension that is already
    // open but minimised is asking to see it again, not to do nothing.
    const open = useCallback((id) => {
        if (!EXTENSION_BY_ID[id]) return;
        setActiveId(id);
        setMinimised(false);
    }, []);

    const close = useCallback(() => {
        setActiveId(null);
        setMinimised(false);
    }, []);

    // Toggling the one that is already open closes it — unless it is minimised,
    // in which case the launcher is the obvious way to get it back on screen.
    const toggle = useCallback((id) => {
        setActiveId((cur) => {
            if (cur !== id) return EXTENSION_BY_ID[id] ? id : cur;
            return minimised ? cur : null;
        });
        setMinimised(false);
    }, [minimised]);

    const setFloat = useCallback((id, geom) => {
        setFloats((prev) => {
            const def = EXTENSION_BY_ID[id] ? EXTENSION_BY_ID[id].float : { w: 560, h: 420 };
            const cur = prev[id] || { x: 56, y: 44, ...def };
            const next = {
                x: Math.round(geom.x ?? cur.x),
                y: Math.round(geom.y ?? cur.y),
                w: Math.round(Math.max(320, geom.w ?? cur.w)),
                h: Math.round(Math.max(200, geom.h ?? cur.h)),
            };
            if (next.x === cur.x && next.y === cur.y && next.w === cur.w && next.h === cur.h) return prev;
            return { ...prev, [id]: next };
        });
    }, []);

    const geometryOf = useCallback((id) => {
        const def = EXTENSION_BY_ID[id] ? EXTENSION_BY_ID[id].float : { w: 560, h: 420 };
        return floats[id] || { x: 56, y: 44, ...def };
    }, [floats]);

    // Only extensions that declare a minimal view can be in one, so a stored
    // flag for one that has since lost it cannot strand the user in a view its
    // component no longer honours.
    const minimalOf = useCallback(
        (id) => !!(EXTENSION_BY_ID[id] && EXTENSION_BY_ID[id].minimal && minimal[id]),
        [minimal],
    );

    const toggleMinimal = useCallback((id) => {
        if (!EXTENSION_BY_ID[id] || !EXTENSION_BY_ID[id].minimal) return;
        setMinimal((prev) => ({ ...prev, [id]: !prev[id] }));
    }, []);

    const value = useMemo(() => ({
        list,
        activeId,
        active: activeId ? EXTENSION_BY_ID[activeId] : null,
        minimised: !!activeId && minimised,
        setMinimised,
        open,
        close,
        toggle,
        geometryOf,
        setFloat,
        minimalOf,
        toggleMinimal,
    }), [list, activeId, minimised, open, close, toggle, geometryOf, setFloat, minimalOf, toggleMinimal]);

    return <ExtensionsContext.Provider value={value}>{children}</ExtensionsContext.Provider>;
}

export function useExtensions() {
    const ctx = useContext(ExtensionsContext);
    if (!ctx) throw new Error('useExtensions outside ExtensionsProvider');
    return ctx;
}
