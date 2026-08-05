// Dock layout: which panels live in which dock, in what order, open or closed.
//
// Panels are registered declaratively (see panels/registry.js) and the layout
// only ever stores their ids, so adding a panel later means adding one entry to
// the registry — no layout migration, no component changes here. Unknown ids in
// a stored layout are dropped and newly registered panels are appended to their
// declared default dock, which keeps saved layouts working across releases.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from '../react.js';
import { PANELS, PANEL_BY_ID } from '../panels/registry.jsx';
import { MOBILE_QUERY } from '../lib/useMediaQuery.js';

const STORAGE_KEY = 'ubersdr.v2.layout';
const VERSION = 1;

export const DOCKS = ['left', 'right', 'bottom'];
// A panel is in exactly one place: one of the docks, or floating free.
export const PLACEMENTS = [...DOCKS, 'float'];

const FLOAT_DEFAULT = { w: 320, h: 320 };
const FLOAT_MIN = { w: 220, h: 120 };
const FLOAT_CASCADE = 26;

// `collapsed` is the first-run state, not a preference: reconcile() below keeps
// whatever a stored layout says, so this only decides what someone arriving for
// the first time sees. Both the right and bottom docks start collapsed to their
// rail — the spectrum is what people come for, and a receiver that opens with
// three columns of panels around it has to be tidied before it can be used.
// Everything in them is one click on the rail away.
const DOCK_DEFAULTS = {
    left: { size: 320, collapsed: false, minSize: 220, maxSize: 560 },
    right: { size: 320, collapsed: true, minSize: 220, maxSize: 560 },
    bottom: { size: 240, collapsed: true, minSize: 120, maxSize: 560 },
};

// Is this a phone, for the purpose of picking first-run defaults?
//
// Read at the moment a default is needed rather than subscribed to: these are
// the values someone arriving for the first time gets, and a layout that
// rearranged itself when a desktop window was dragged narrower would be undoing
// an arrangement its owner had made. Once stored, the layout is the authority.
function onPhone() {
    try { return window.matchMedia(MOBILE_QUERY).matches; } catch (e) { return false; }
}

// The panel's first-run state, honouring its `mobile` block on a handset. Two
// machines can want opposite answers for the same panel — the Multipad is off
// on a desktop and is the first thing a phone shows — and the registry is where
// that is said, so it is read here rather than being decided per shell.
function firstRun(p, phone) {
    const m = (phone && p.mobile) || {};
    return {
        open: p.defaultOpen !== false,
        hidden: m.hidden != null ? !!m.hidden : !!p.defaultHidden,
        minimal: false,
        // On a phone every panel starts cut down, this one included. A sheet
        // over the spectrum has a fraction of a dock's room, and the minimal
        // view is the part of a panel worth having in that space — see
        // minimalMobile below. One rule for all of them: a panel that opened
        // whole where its neighbours opened trimmed would read as one that had
        // forgotten the setting rather than as one making a point.
        minimalMobile: true,
    };
}

function defaultLayout() {
    const docks = {};
    for (const dock of DOCKS) {
        docks[dock] = { ...DOCK_DEFAULTS[dock], panels: [] };
    }
    const phone = onPhone();
    const sections = {};
    for (const p of PANELS) {
        docks[p.dock].panels.push(p.id);
        sections[p.id] = firstRun(p, phone);
    }
    return { version: VERSION, docks, sections, floats: {}, floatOrder: [], weights: {}, heights: {} };
}

// Merges a stored layout with the current panel registry.
function reconcile(stored) {
    const base = defaultLayout();
    if (!stored || stored.version !== VERSION) return base;

    // Floating panels belong to no dock, so they are resolved first and then
    // excluded from every dock list.
    const floats = {};
    const floatOrder = [];
    for (const id of stored.floatOrder || Object.keys(stored.floats || {})) {
        const g = (stored.floats || {})[id];
        if (!PANEL_BY_ID[id] || !g || floats[id]) continue;
        floats[id] = {
            x: Number(g.x) || 0,
            y: Number(g.y) || 0,
            w: Math.max(FLOAT_MIN.w, Number(g.w) || FLOAT_DEFAULT.w),
            h: Math.max(FLOAT_MIN.h, Number(g.h) || FLOAT_DEFAULT.h),
            // Minimised: still floating, but shown as a chip in the strip along
            // the bottom of the centre area rather than as a window. The
            // geometry is kept so restoring puts it back where it was.
            min: !!g.min,
        };
        floatOrder.push(id);
    }
    base.floats = floats;
    base.floatOrder = floatOrder;
    // Share of the bottom dock's width, per panel. Missing entries default to 1
    // at render time, so a newly registered panel needs no migration.
    base.weights = {};
    for (const [id, w] of Object.entries(stored.weights || {})) {
        if (PANEL_BY_ID[id] && Number.isFinite(Number(w)) && Number(w) > 0) base.weights[id] = Number(w);
    }
    // Explicit heights for bottom-dock panels. Absent means "auto" — content
    // height, or the dock height for a `fill` panel.
    base.heights = {};
    for (const [id, h] of Object.entries(stored.heights || {})) {
        if (PANEL_BY_ID[id] && Number.isFinite(Number(h)) && Number(h) > 0) base.heights[id] = Number(h);
    }

    const seen = new Set(floatOrder);
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
    // Panels added since the layout was saved land in their default dock, at
    // the position the registry declares for them — after the nearest sibling
    // that is already there, or before the nearest one that follows.
    //
    // Appending instead would drop every new panel at the bottom of an existing
    // user's dock, so a panel declared "directly under Receiver" would show up
    // under everything else for anyone who had used the app before.
    for (const p of PANELS) {
        if (seen.has(p.id)) continue;
        const list = base.docks[p.dock].panels;
        const siblings = PANELS.filter((q) => q.dock === p.dock).map((q) => q.id);
        const mine = siblings.indexOf(p.id);

        let at = -1;
        for (let i = mine - 1; i >= 0 && at < 0; i--) {
            const k = list.indexOf(siblings[i]);
            if (k >= 0) at = k + 1;
        }
        for (let i = mine + 1; i < siblings.length && at < 0; i++) {
            const k = list.indexOf(siblings[i]);
            if (k >= 0) at = k;
        }
        // No sibling is in this dock — the user moved them all away.
        list.splice(at < 0 ? list.length : at, 0, p.id);
    }
    for (const dock of DOCKS) {
        base.docks[dock].panels = base.docks[dock].panels.filter((id) => !floats[id]);
    }
    base.sections = {};
    const phone = onPhone();
    for (const p of PANELS) {
        const s = stored.sections?.[p.id];
        // A panel registered since this layout was stored has no entry at all,
        // so it gets its first-run state — including the phone's answer where
        // the registry gives one.
        const d = firstRun(p, phone);
        base.sections[p.id] = {
            open: s?.open ?? d.open,
            hidden: s?.hidden ?? d.hidden,
            // Only panels that declare a minimal view can be in one, so a
            // stored flag on a panel that has since dropped it is discarded
            // rather than leaving the panel stuck showing nothing extra.
            minimal: !!p.minimal && !!s?.minimal,
            // `?? d.minimalMobile` rather than `!!`: absent means a layout
            // stored before this existed, and those should get the default like
            // everybody else, not be pinned to full because the key was missing.
            minimalMobile: !!p.minimal && (s?.minimalMobile ?? d.minimalMobile),
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

    // Minimal view: the panel renders its cut-down form. It is per panel and
    // not per placement, so a panel reads the same whether it is docked or
    // floating — the point is what you want to see from it, not where it is.
    //
    // A phone is the exception, and it is a difference of kind rather than of
    // placement: a sheet over the spectrum has a fraction of a dock's room, so
    // panels start cut down there and are remembered separately. Otherwise
    // trimming a panel to fit a phone would trim it on the desktop too, and the
    // machine you are not holding is the one that had room for all of it.
    const toggleSectionMinimal = useCallback((id, mobile = false) => {
        const key = mobile ? 'minimalMobile' : 'minimal';
        setLayout((l) => ({
            ...l,
            sections: { ...l.sections, [id]: { ...l.sections[id], [key]: !l.sections[id]?.[key] } },
        }));
    }, []);

    const setSectionHidden = useCallback((id, hidden) => {
        setLayout((l) => ({
            ...l,
            sections: { ...l.sections, [id]: { ...l.sections[id], hidden } },
        }));
    }, []);

    // Moves a panel to `dock` at `index` (append when index is null).
    // `dock` may also be 'float', which detaches it from every dock.
    const movePanel = useCallback((id, dock, index) => {
        setLayout((l) => {
            const docks = {};
            for (const d of DOCKS) {
                docks[d] = { ...l.docks[d], panels: l.docks[d].panels.filter((p) => p !== id) };
            }
            const floats = { ...l.floats };
            let floatOrder = l.floatOrder.filter((f) => f !== id);
            const sections = { ...l.sections, [id]: { ...l.sections[id], hidden: false } };

            if (dock === 'float') {
                if (!floats[id]) {
                    // Cascade so a second float does not land exactly on the first.
                    const n = floatOrder.length;
                    floats[id] = {
                        x: 48 + n * FLOAT_CASCADE,
                        y: 40 + n * FLOAT_CASCADE,
                        ...FLOAT_DEFAULT,
                        min: false,
                    };
                } else if (floats[id].min) {
                    // Asking for it to float again means asking to see it.
                    floats[id] = { ...floats[id], min: false };
                }
                floatOrder = [...floatOrder, id];
                // A floating panel is always expanded; a collapsed window with
                // nothing but a title bar is just clutter.
                sections[id] = { ...sections[id], open: true };
                return { ...l, docks, floats, floatOrder, sections };
            }

            delete floats[id];
            const target = docks[dock];
            const at = index == null ? target.panels.length : Math.max(0, Math.min(target.panels.length, index));
            target.panels = [...target.panels.slice(0, at), id, ...target.panels.slice(at)];
            // Moving a panel into a collapsed dock should reveal it.
            if (target.collapsed) target.collapsed = false;
            return { ...l, docks, floats, floatOrder, sections };
        });
    }, []);

    // "Show me that panel", from somewhere outside the docks — the top bar's
    // space weather summary is the first caller. Whatever is in the way is
    // undone: the panel is un-hidden, its section opened, and the dock it lives
    // in expanded. A floating panel is un-minimised and raised instead, since
    // for it those are the same three obstacles.
    //
    // Deliberately not a move: revealing must not take a panel away from
    // wherever the operator has put it.
    const revealPanel = useCallback((id) => {
        setLayout((l) => {
            if (!PANEL_BY_ID[id]) return l;
            const sections = { ...l.sections, [id]: { ...l.sections[id], hidden: false, open: true } };
            if (l.floats[id]) {
                return {
                    ...l,
                    sections,
                    floats: { ...l.floats, [id]: { ...l.floats[id], min: false } },
                    floatOrder: [...l.floatOrder.filter((f) => f !== id), id],
                };
            }
            const dock = DOCKS.find((d) => l.docks[d].panels.includes(id));
            if (!dock) return { ...l, sections };
            return { ...l, sections, docks: { ...l.docks, [dock]: { ...l.docks[dock], collapsed: false } } };
        });
    }, []);

    const setFloat = useCallback((id, geom) => {
        setLayout((l) => {
            const cur = l.floats[id];
            if (!cur) return l;
            const next = {
                ...cur,
                x: Math.round(geom.x ?? cur.x),
                y: Math.round(geom.y ?? cur.y),
                w: Math.round(Math.max(FLOAT_MIN.w, geom.w ?? cur.w)),
                h: Math.round(Math.max(FLOAT_MIN.h, geom.h ?? cur.h)),
            };
            if (next.x === cur.x && next.y === cur.y && next.w === cur.w && next.h === cur.h) return l;
            return { ...l, floats: { ...l.floats, [id]: next } };
        });
    }, []);

    // Minimise / restore a floating window. A minimised panel stays mounted —
    // it is only rendered as a chip — so a running panel keeps running.
    const setFloatMin = useCallback((id, min) => {
        setLayout((l) => {
            const cur = l.floats[id];
            if (!cur || !!cur.min === !!min) return l;
            const floats = { ...l.floats, [id]: { ...cur, min: !!min } };
            // Restoring also raises: you expect what you just clicked on top.
            const floatOrder = min ? l.floatOrder : [...l.floatOrder.filter((f) => f !== id), id];
            return { ...l, floats, floatOrder };
        });
    }, []);

    // Click-to-front: the last id in floatOrder paints on top.
    const raiseFloat = useCallback((id) => {
        setLayout((l) => {
            if (!l.floats[id] || l.floatOrder[l.floatOrder.length - 1] === id) return l;
            return { ...l, floatOrder: [...l.floatOrder.filter((f) => f !== id), id] };
        });
    }, []);

    const placementOf = useCallback((id) => {
        if (layout.floats[id]) return 'float';
        return DOCKS.find((d) => layout.docks[d].panels.includes(id)) || 'left';
    }, [layout]);

    // Adjusts two neighbours together so the row keeps its total width.
    const setWeights = useCallback((pairs) => {
        setLayout((l) => {
            const weights = { ...l.weights };
            let changed = false;
            for (const [id, w] of pairs) {
                const next = Math.max(0.2, Math.round(w * 1000) / 1000);
                if (weights[id] !== next) { weights[id] = next; changed = true; }
            }
            return changed ? { ...l, weights } : l;
        });
    }, []);

    // null clears the override and returns the panel to automatic height.
    const setPanelHeight = useCallback((id, h) => {
        setLayout((l) => {
            const heights = { ...l.heights };
            if (h == null) {
                if (!(id in heights)) return l;
                delete heights[id];
            } else {
                const next = Math.max(90, Math.round(h));
                if (heights[id] === next) return l;
                heights[id] = next;
            }
            return { ...l, heights };
        });
    }, []);

    const resetLayout = useCallback(() => setLayout(defaultLayout()), []);

    const value = useMemo(() => ({
        layout,
        docks: layout.docks,
        sections: layout.sections,
        floats: layout.floats,
        floatOrder: layout.floatOrder,
        weights: layout.weights,
        setWeights,
        heights: layout.heights,
        setPanelHeight,
        setFloat,
        setFloatMin,
        raiseFloat,
        placementOf,
        toggleDock,
        setDockCollapsed,
        setDockSize,
        toggleSection,
        toggleSectionMinimal,
        setSectionHidden,
        movePanel,
        revealPanel,
        resetLayout,
    }), [layout, toggleDock, setDockCollapsed, setDockSize, toggleSection, toggleSectionMinimal, setSectionHidden, movePanel,
        revealPanel, setFloat, setFloatMin, raiseFloat, placementOf, setWeights, setPanelHeight, resetLayout]);

    return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
}

export function useLayout() {
    const ctx = useContext(LayoutContext);
    if (!ctx) throw new Error('useLayout outside LayoutProvider');
    return ctx;
}
