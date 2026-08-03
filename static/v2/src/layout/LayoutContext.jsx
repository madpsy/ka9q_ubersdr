// Dock layout: which panels live in which dock, in what order, open or closed.
//
// Panels are registered declaratively (see panels/registry.js) and the layout
// only ever stores their ids, so adding a panel later means adding one entry to
// the registry — no layout migration, no component changes here. Unknown ids in
// a stored layout are dropped and newly registered panels are appended to their
// declared default dock, which keeps saved layouts working across releases.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from '../react.js';
import { PANELS, PANEL_BY_ID } from '../panels/registry.jsx';

const STORAGE_KEY = 'ubersdr.v2.layout';
const VERSION = 1;

export const DOCKS = ['left', 'right', 'bottom'];

const DOCK_DEFAULTS = {
    left: { size: 320, collapsed: false, minSize: 220, maxSize: 560 },
    right: { size: 320, collapsed: false, minSize: 220, maxSize: 560 },
    bottom: { size: 240, collapsed: true, minSize: 120, maxSize: 560 },
};

function defaultLayout() {
    const docks = {};
    for (const dock of DOCKS) {
        docks[dock] = { ...DOCK_DEFAULTS[dock], panels: [] };
    }
    const sections = {};
    for (const p of PANELS) {
        docks[p.dock].panels.push(p.id);
        sections[p.id] = { open: p.defaultOpen !== false, hidden: !!p.defaultHidden };
    }
    return { version: VERSION, docks, sections };
}

// Merges a stored layout with the current panel registry.
function reconcile(stored) {
    const base = defaultLayout();
    if (!stored || stored.version !== VERSION) return base;

    const seen = new Set();
    for (const dock of DOCKS) {
        const list = (stored.docks?.[dock]?.panels || []).filter((id) => {
            if (!PANEL_BY_ID[id] || seen.has(id)) return false;
            seen.add(id);
            return true;
        });
        base.docks[dock] = {
            ...DOCK_DEFAULTS[dock],
            size: stored.docks?.[dock]?.size ?? DOCK_DEFAULTS[dock].size,
            collapsed: stored.docks?.[dock]?.collapsed ?? DOCK_DEFAULTS[dock].collapsed,
            panels: list,
        };
    }
    // Panels added since the layout was saved land in their default dock.
    for (const p of PANELS) {
        if (!seen.has(p.id)) base.docks[p.dock].panels.push(p.id);
    }
    base.sections = {};
    for (const p of PANELS) {
        const s = stored.sections?.[p.id];
        base.sections[p.id] = {
            open: s?.open ?? (p.defaultOpen !== false),
            hidden: s?.hidden ?? !!p.defaultHidden,
        };
    }
    return base;
}

function load() {
    try {
        return reconcile(JSON.parse(localStorage.getItem(STORAGE_KEY)));
    } catch (e) {
        return defaultLayout();
    }
}

const LayoutContext = createContext(null);

export function LayoutProvider({ children }) {
    const [layout, setLayout] = useState(load);

    useEffect(() => {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(layout)); } catch (e) { /* ignore */ }
    }, [layout]);

    const toggleDock = useCallback((dock) => {
        setLayout((l) => ({
            ...l,
            docks: { ...l.docks, [dock]: { ...l.docks[dock], collapsed: !l.docks[dock].collapsed } },
        }));
    }, []);

    const setDockCollapsed = useCallback((dock, collapsed) => {
        setLayout((l) => ({
            ...l,
            docks: { ...l.docks, [dock]: { ...l.docks[dock], collapsed } },
        }));
    }, []);

    const setDockSize = useCallback((dock, size) => {
        setLayout((l) => {
            const d = l.docks[dock];
            const clamped = Math.max(d.minSize, Math.min(d.maxSize, Math.round(size)));
            if (clamped === d.size) return l;
            return { ...l, docks: { ...l.docks, [dock]: { ...d, size: clamped } } };
        });
    }, []);

    const toggleSection = useCallback((id) => {
        setLayout((l) => ({
            ...l,
            sections: { ...l.sections, [id]: { ...l.sections[id], open: !l.sections[id].open } },
        }));
    }, []);

    const setSectionHidden = useCallback((id, hidden) => {
        setLayout((l) => ({
            ...l,
            sections: { ...l.sections, [id]: { ...l.sections[id], hidden } },
        }));
    }, []);

    // Moves a panel to `dock` at `index` (append when index is null).
    const movePanel = useCallback((id, dock, index) => {
        setLayout((l) => {
            const docks = {};
            for (const d of DOCKS) {
                docks[d] = { ...l.docks[d], panels: l.docks[d].panels.filter((p) => p !== id) };
            }
            const target = docks[dock];
            const at = index == null ? target.panels.length : Math.max(0, Math.min(target.panels.length, index));
            target.panels = [...target.panels.slice(0, at), id, ...target.panels.slice(at)];
            // Moving a panel into a collapsed dock should reveal it.
            if (target.collapsed) target.collapsed = false;
            return { ...l, docks, sections: { ...l.sections, [id]: { ...l.sections[id], hidden: false } } };
        });
    }, []);

    const resetLayout = useCallback(() => setLayout(defaultLayout()), []);

    const value = useMemo(() => ({
        layout,
        docks: layout.docks,
        sections: layout.sections,
        toggleDock,
        setDockCollapsed,
        setDockSize,
        toggleSection,
        setSectionHidden,
        movePanel,
        resetLayout,
    }), [layout, toggleDock, setDockCollapsed, setDockSize, toggleSection, setSectionHidden, movePanel, resetLayout]);

    return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
}

export function useLayout() {
    const ctx = useContext(LayoutContext);
    if (!ctx) throw new Error('useLayout outside LayoutProvider');
    return ctx;
}
