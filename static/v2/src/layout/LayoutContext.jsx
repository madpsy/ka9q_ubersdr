// Dock layout: which panels live in which dock, in what order, open or closed.
//
// Panels are registered declaratively (see panels/registry.js) and the layout
// only ever stores their ids, so adding a panel later means adding one entry to
// the registry — no layout migration, no component changes here. Newly
// registered panels are placed in their declared default dock, next to the
// siblings the registry puts them beside, which keeps saved layouts working
// across releases.
//
// An id the registry does not currently know is *parked*, not discarded — see
// parkedIds below.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from '../react.js';
import { PANELS, PANEL_BY_ID } from '../panels/registry.jsx';
import { MOBILE_QUERY, TOUCH_QUERY } from '../lib/useMediaQuery.js';
import { cleanScale } from '../lib/panelScale.js';
import { PINNABLE } from '../lib/dockPin.js';

const STORAGE_KEY = 'ubersdr.v2.layout';
const VERSION = 1;

// One-shot additions to a layout that is otherwise kept as it is.
//
// VERSION is all-or-nothing — a mismatch throws the stored layout away — which
// is right for a shape change and far too blunt for "this panel should now
// appear on machines it never appeared on". Every returning visitor has a stored
// layout, so a first-run default alone reaches nobody who is already here.
//
// So: a revision the migrations below key off, applied once and then recorded.
// Each one must be conservative enough that it cannot undo an arrangement
// somebody made — see migrateRev.
export const REV = 2;

export const DOCKS = ['left', 'right', 'bottom'];
// A panel is in exactly one place: one of the docks, or floating free.
export const PLACEMENTS = [...DOCKS, 'float'];

const FLOAT_DEFAULT = { w: 320, h: 320 };

// Float heights that were a default once and are too small for what the panel
// shows now.
//
// The multipad has done this twice, the same way each time: 188 was measured
// without the squelch its minimal view includes, and 213 was measured when that
// view still dropped the filter width on a narrow pad instead of stacking it.
// Both times the control clipped was one of the two adjusted while listening,
// which is the whole reason either is on this panel.
//
// Keyed by panel, and matched exactly: a float still sitting at one of these
// was never resized by hand, so correcting it cannot undo an arrangement
// anybody made. A float at any other height was, and is left alone — which is
// the rule every migration here has to satisfy. The list grows rather than being
// replaced, so a window skipped at one release is still corrected at the next.
const OUTGROWN_FLOAT_HEIGHTS = { multipad: [188, 213] };

// Panels whose minimal view arrived after `minimalMobile` did.
//
// Between the two, every layout written recorded `minimalMobile: false` for a
// panel with no minimal view — a flag with nothing behind it, and one nobody
// chose. When such a panel later declares one, that stored `false` reads as the
// operator having asked for the full view and pins it there: on a phone it
// opened whole while every one of its neighbours opened cut down. The Layout
// panel is the one that made this visible, being the most recent of them.
//
// So their stored answer is ignored exactly once — see `repairMinimal` in
// reconcile — and after that the layout is written by a build that no longer
// coins the flag, so absent means absent and a panel that gains a minimal view
// from here on takes the default with nothing to undo. Which is why this list
// can never need another entry, and why it is a list rather than a rule: a
// blanket reset would also throw away the answers people did give.
const MINIMAL_LATECOMERS = new Set([
    'antenna', 'bands', 'bandspectrum', 'bandstats', 'bookmarks', 'clocks',
    'doppler', 'games', 'hfdl', 'ifspectrum', 'layout', 'lightning',
    'localbookmarks', 'log', 'multipad', 'navtex', 'news', 'noise',
    'notifications', 'packet', 'ranking', 'rotator', 'spectrogram',
    'topfreq', 'vfos', 'voiceskimmer', 'weather', 'wefax',
]);
// The Layout panel: the one panel that cannot be hidden, because it is the one that
// brings the others back. Named here rather than tested for inline so the reason has
// somewhere to live and the id appears once.
export const UNHIDEABLE = 'layout';

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
    // The bottom dock's real ceiling is measured, not fixed: it is a share of
    // the column it shares with the spectrum, applied by `max-height` in
    // styles.css and by dockCeiling() in Dock.jsx. A fixed 560 here would bind
    // first on any tall window and undo both. What is left is a sanity bound on
    // the stored number — far enough out to be reached only by an edited or
    // corrupted layout.
    bottom: { size: 240, collapsed: true, minSize: 120, maxSize: 1600 },
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

// A touchscreen on something that is not a handset: a convertible laptop, a
// tablet in a dock, a touch monitor. Read the same way and for the same reason.
function onTouchDesktop() {
    try {
        return !onPhone() && window.matchMedia(TOUCH_QUERY).matches;
    } catch (e) {
        return false;
    }
}

// The two answers together, read once per layout build.
//
// Passed down rather than queried inside every helper so the whole first-run and
// migration story is a pure function of (stored layout, machine) — which is what
// makes it testable without a DOM, and there are enough interacting rules here
// now to want that.
function machine() {
    return { phone: onPhone(), touch: onTouchDesktop() };
}

// Which registry block gives this machine's first-run answers, if any. A phone
// is a phone first — it has a touchscreen too, and `mobile` is the more specific
// statement about it.
function firstRunBlock(p, phone, touch) {
    if (phone) return p.mobile || null;
    if (touch) return p.touch || null;
    return null;
}

// The panel's first-run state, honouring whichever block applies. Different
// machines can want opposite answers for the same panel — the Multipad is off on
// a mouse-only desktop, floating on a touchscreen one, and the first thing a
// phone shows — and the registry is where that is said, so it is read here
// rather than being decided per shell.
function firstRun(p, phone, touch) {
    const m = firstRunBlock(p, phone, touch) || {};
    return {
        open: p.defaultOpen !== false,
        hidden: m.hidden != null ? !!m.hidden : !!p.defaultHidden,
        // `undefined` rather than `false` where the panel has no cut-down view
        // at all, so that nothing is stored for it. A `false` written here is
        // indistinguishable later from one the operator chose, and a panel that
        // gains a minimal view in a later build would then be held at "full" by
        // an answer nobody gave — see MINIMAL_LATECOMERS.
        //
        // `defaultMinimal` is the panel's own answer for a machine with no block
        // of its own — a mouse-only desktop, where until now every panel opened
        // whole whatever it thought about that. Read the same way `hidden` reads
        // `defaultHidden`: the machine's block wins where it says anything, and
        // this is what is left.
        minimal: p.minimal
            ? (m.minimal != null ? !!m.minimal : !!p.defaultMinimal)
            : undefined,
        // On a phone every panel starts cut down, this one included. A sheet
        // over the spectrum has a fraction of a dock's room, and the minimal
        // view is the part of a panel worth having in that space — see
        // minimalMobile below. One rule for all of them: a panel that opened
        // whole where its neighbours opened trimmed would read as one that had
        // forgotten the setting rather than as one making a point.
        minimalMobile: p.minimal ? true : undefined,
        // Text size, as an offset from the global one — see lib/panelScale.js.
        // Nobody's first run wants a panel out of step with the rest.
        scale: 0,
    };
}

// The geometry a `touch.float` block asks for. `x`/`y` are placeholders: the
// anchor is what says where it goes, and only the floating layer knows how big
// it is — see resolveAnchor there.
function seedFloat(spec) {
    return {
        x: 0,
        y: 0,
        w: Math.max(FLOAT_MIN.w, Number(spec.w) || FLOAT_DEFAULT.w),
        h: Math.max(FLOAT_MIN.h, Number(spec.h) || FLOAT_DEFAULT.h),
        min: false,
        anchor: spec.anchor || 'bottom-left',
    };
}

/**
 * Where a dragged panel goes, relative to the panel it was dropped on.
 *
 * `panels` must already have the dragged id removed. That ordering is the whole
 * point: dropping a panel below one of its own neighbours used to insert at the
 * index the anchor had *before* the removal, which is one slot too early — so
 * dragging a panel down by one place did nothing at all, and dragging it
 * further landed it short of where it was let go.
 *
 * Anchored on the neighbour's id rather than on a number for the same reason
 * swapPanels is: a dock's list also holds panels that are hidden, or that do not
 * apply to this receiver, so the third panel you can see is not the third in the
 * array. An index taken from the screen puts the panel somewhere else entirely.
 */
export function insertNear(panels, id, anchorId, edge) {
    // Dropped on itself: a no-op, not a request to go anywhere. Falling through
    // would remove it, fail to find the anchor, and append — which is the drop
    // that sent panels to the bottom of the dock.
    if (!id || id === anchorId) return panels.slice();
    const rest = panels.filter((p) => p !== id);
    let at = rest.indexOf(anchorId);
    if (at === -1) at = rest.length;            // anchor gone: the end will do
    else if (edge === 'after') at += 1;
    return [...rest.slice(0, at), id, ...rest.slice(at)];
}

export function defaultLayout(env = machine()) {
    const { phone, touch } = env;
    const docks = {};
    for (const dock of DOCKS) {
        docks[dock] = { ...DOCK_DEFAULTS[dock], panels: [] };
    }
    const sections = {};
    const floats = {};
    const floatOrder = [];
    for (const p of PANELS) {
        sections[p.id] = firstRun(p, phone, touch);
        // A panel this machine opens as a window belongs to no dock, the same
        // rule reconcile() applies to a stored one.
        const spec = (firstRunBlock(p, phone, touch) || {}).float;
        if (spec) {
            floats[p.id] = seedFloat(spec);
            floatOrder.push(p.id);
        } else {
            docks[p.dock].panels.push(p.id);
        }
    }
    return {
        version: VERSION,
        // A layout built on a machine the rev-N additions do not apply to has
        // not really been offered them — see migrateRev.
        rev: touch ? REV : 0,
        // Nothing to repair in a layout this build wrote from scratch — see
        // MINIMAL_LATECOMERS. Its own flag rather than a rev, because the rev
        // migrations are for touchscreen desktops and skip phones entirely,
        // which is the one machine this matters on.
        minimalRepaired: true,
        docks,
        sections,
        floats,
        floatOrder,
        weights: {},
        heights: {},
        // Nothing pinned to the top of a side dock to begin with — see
        // lib/dockPin.js. A first run has not been scrolled yet, so there is
        // nothing to hold still.
        pins: { left: null, right: null },
    };
}

// How many unknown ids a stored layout will carry.
//
// A bound rather than an expectation: the ids parked here come from panels that
// existed on this receiver once, of which there can only ever be a few. The cap
// is what stops a bug somewhere upstream — a manifest handing out a fresh id on
// every fetch, say — growing this file without limit in a store that is a few
// megabytes for the whole origin.
const MAX_PARKED = 64;

/**
 * Ids in a stored layout that match no registered panel.
 *
 * These used to be dropped, and dropping them was a quiet way to destroy
 * somebody's arrangement. `LayoutProvider` writes the layout back on mount, so
 * a reconcile that pruned an id persisted the pruning immediately — before the
 * user had touched anything, and with no way back.
 *
 * That is fine when a panel has genuinely been retired, and wrong every other
 * time an id is briefly unknown:
 *
 *   - a custom panel whose manifest has not arrived yet, or whose fetch failed
 *     once (see panels/custom and CUSTOM_PANELS.md §4.1);
 *   - a panel the operator has disabled and will enable again, whose `hidden`
 *     flag is the answer somebody already gave and should not be asked for
 *     twice;
 *   - a build that briefly ships without a panel, on a browser profile that
 *     will meet the next one.
 *
 * So an unknown id keeps its place in the dock, its float geometry, its width,
 * its height and its section state, and simply renders as nothing: every
 * consumer already filters on `PANEL_BY_ID` before drawing — Dock.jsx's
 * `visible`, FloatingLayer's `floatOrder` filter — and the mobile shell and the
 * layout manager iterate the registry rather than the layout. Parking costs a
 * few bytes in localStorage and saves an arrangement.
 */
function parkedIds(stored) {
    const out = new Set();
    const add = (id) => {
        if (typeof id !== 'string' || !id) return;
        if (PANEL_BY_ID[id] || out.has(id)) return;
        if (out.size >= MAX_PARKED) return;
        out.add(id);
    };
    for (const id of stored.floatOrder || Object.keys(stored.floats || {})) add(id);
    for (const dock of DOCKS) for (const id of stored.docks?.[dock]?.panels || []) add(id);
    return out;
}

// Merges a stored layout with the current panel registry.
export function reconcile(stored, env = machine()) {
    const base = defaultLayout(env);
    if (!stored || stored.version !== VERSION) return base;

    // Registered here, or parked from a previous life. Everything below asks
    // this rather than the registry directly.
    const parked = parkedIds(stored);
    const keep = (id) => !!PANEL_BY_ID[id] || parked.has(id);

    // Floating panels belong to no dock, so they are resolved first and then
    // excluded from every dock list.
    const floats = {};
    const floatOrder = [];
    for (const id of stored.floatOrder || Object.keys(stored.floats || {})) {
        const g = (stored.floats || {})[id];
        if (!keep(id) || !g || floats[id]) continue;
        floats[id] = {
            x: Number(g.x) || 0,
            y: Number(g.y) || 0,
            w: Math.max(FLOAT_MIN.w, Number(g.w) || FLOAT_DEFAULT.w),
            h: Math.max(FLOAT_MIN.h, Number(g.h) || FLOAT_DEFAULT.h),
            // Minimised: still floating, but shown as a chip in the strip along
            // the bottom of the centre area rather than as a window. The
            // geometry is kept so restoring puts it back where it was.
            min: !!g.min,
            // Normally absent. A seeded window carries one until the floating
            // layer has measured itself and can turn it into a position, which
            // may be a reload later if the panel was never on screen.
            ...(g.anchor ? { anchor: String(g.anchor) } : null),
        };
        floatOrder.push(id);
    }
    base.floats = floats;
    base.floatOrder = floatOrder;
    // Share of the bottom dock's width, per panel. Missing entries default to 1
    // at render time, so a newly registered panel needs no migration.
    base.weights = {};
    for (const [id, w] of Object.entries(stored.weights || {})) {
        if (keep(id) && Number.isFinite(Number(w)) && Number(w) > 0) base.weights[id] = Number(w);
    }
    // Explicit heights for bottom-dock panels. Absent means "auto" — content
    // height, or the dock height for a `fill` panel.
    base.heights = {};
    for (const [id, h] of Object.entries(stored.heights || {})) {
        if (keep(id) && Number.isFinite(Number(h)) && Number(h) > 0) base.heights[id] = Number(h);
    }

    const seen = new Set(floatOrder);
    for (const dock of DOCKS) {
        const list = (stored.docks?.[dock]?.panels || []).filter((id) => {
            if (!keep(id) || seen.has(id)) return false;
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
    // Which panel is pinned to the top of each side dock — see lib/dockPin.js.
    //
    // Checked against the dock it claims to be in, and checked here rather than
    // at the top of reconcile because the answer depends on where every panel
    // ended up: a pin on a panel that has since been floated, moved to the other
    // dock or retired is not a pin at all, and keeping the id would make a
    // stored layout claim something that is no longer true.
    base.pins = { left: null, right: null };
    for (const side of PINNABLE) {
        const id = stored.pins?.[side];
        if (typeof id === 'string' && base.docks[side].panels.includes(id)) base.pins[side] = id;
    }
    // Once per stored layout, and recorded by `base` already carrying the flag
    // from defaultLayout.
    const repairMinimal = !stored.minimalRepaired;
    base.sections = {};
    const { phone, touch } = env;
    for (const p of PANELS) {
        const s = stored.sections?.[p.id];
        // A panel registered since this layout was stored has no entry at all,
        // so it gets its first-run state — including this machine's answer where
        // the registry gives one.
        const d = firstRun(p, phone, touch);
        base.sections[p.id] = {
            open: s?.open ?? d.open,
            // Un-hidden on the way in if it is the panel that cannot be hidden: a layout
            // stored before that rule existed can have it hidden, and somebody in that
            // state has no way to ask for it back. See UNHIDEABLE.
            hidden: p.id === UNHIDEABLE ? false : (s?.hidden ?? d.hidden),
            // Only panels that declare a minimal view can be in one, so a
            // stored flag on a panel that has since dropped it is discarded
            // rather than leaving the panel stuck showing nothing extra.
            // `?? d.minimal` for the same reason as minimalMobile below: a panel
            // with no stored entry is new here, and takes the default.
            minimal: p.minimal ? (s?.minimal ?? d.minimal) : undefined,
            // `?? d.minimalMobile` rather than `!!`: absent means a layout
            // stored before this existed, and those should get the default like
            // everybody else, not be pinned to full because the key was missing.
            //
            // A latecomer's stored answer is dropped once, because it is not an
            // answer: it is the `false` older builds wrote for every panel that
            // had no minimal view yet. See MINIMAL_LATECOMERS.
            minimalMobile: p.minimal
                ? ((repairMinimal && MINIMAL_LATECOMERS.has(p.id) ? undefined : s?.minimalMobile)
                    ?? d.minimalMobile)
                : undefined,
            // Cleaned rather than trusted: this one is a free number rather than
            // a flag, so a hand-edited or half-written layout can put anything
            // here, and anything here ends up multiplying every font size in the
            // panel. See cleanScale.
            scale: cleanScale(s?.scale ?? d.scale),
        };
    }
    // And the section state of the parked ids, kept as it was stored.
    //
    // `hidden` is the one that matters. A panel the operator disables and later
    // enables again must come back exactly as the user left it — off, if they
    // turned it off — because nothing has happened in between to ask them the
    // question a second time. There is no registry entry to take defaults from,
    // so each field falls back to what a panel gets when it has no opinion.
    for (const id of parked) {
        const s = stored.sections?.[id];
        if (!s || typeof s !== 'object') continue;
        base.sections[id] = {
            open: s.open !== false,
            hidden: !!s.hidden,
            // As above: absent stays absent, so a panel that comes back with a
            // minimal view it did not have takes the default rather than a
            // `false` this line invented.
            minimal: s.minimal == null ? undefined : !!s.minimal,
            minimalMobile: s.minimalMobile == null ? undefined : !!s.minimalMobile,
            scale: cleanScale(s.scale),
        };
    }
    return migrateRev(base, stored, phone, touch);
}

/**
 * One-shot changes to a layout that already exists.
 *
 * The rule every migration here has to obey: only add what this machine has
 * never had an opinion about. A layout is somebody's arrangement, and a
 * migration that moved a panel they had placed, or brought back one they had
 * hidden, would be worse than the feature it is delivering.
 *
 * rev 1 — a panel with a `touch` block, on a touchscreen desktop, for a layout
 *         stored before those existed. Guarded twice over: the panel must not be
 *         floating already, and it must still be sitting at the default the
 *         registry gives a mouse-only machine. Anyone who had gone and found the
 *         Multipad in the layout manager keeps it exactly where they put it.
 */
function migrateRev(base, stored, phone, touch) {
    if ((Number(stored.rev) || 0) >= REV) return base;
    // Not this machine — but leave the layout eligible rather than recording the
    // revision as done. The same browser profile meets a touchscreen later often
    // enough to matter: a laptop docked to one, tablet mode switched on, a
    // profile synced to a second machine.
    if (phone || !touch) {
        base.rev = Number(stored.rev) || 0;
        return base;
    }

    for (const p of PANELS) {
        const spec = (p.touch || {}).float;
        if (!spec || base.floats[p.id]) continue;
        const s = stored.sections?.[p.id];
        // Untouched means: no stored entry at all, or one still holding the
        // mouse-only default.
        if (s && !!s.hidden !== !!p.defaultHidden) continue;

        base.floats = { ...base.floats, [p.id]: seedFloat(spec) };
        base.floatOrder = [...base.floatOrder, p.id];
        for (const dock of DOCKS) {
            base.docks[dock].panels = base.docks[dock].panels.filter((id) => id !== p.id);
        }
        base.sections[p.id] = { ...base.sections[p.id], ...firstRun(p, phone, touch) };
    }

    // rev 2: a float already seeded at a height that has since been outgrown.
    // Nothing to do for one seeded just above — it is already the new size.
    for (const p of PANELS) {
        const spec = (p.touch || {}).float;
        const outgrown = OUTGROWN_FLOAT_HEIGHTS[p.id];
        const float = base.floats[p.id];
        if (!spec || !outgrown || !float) continue;
        if (float.h < spec.h && outgrown.includes(Math.round(float.h))) {
            base.floats = { ...base.floats, [p.id]: { ...float, h: spec.h } };
        }
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

    // Text size for one panel, as an offset from the global — see
    // lib/panelScale.js for why an offset rather than a size. The caller works
    // out the new offset because it is the one that knows the global scale and
    // the range the display settings allow; this only has to store it.
    const setSectionScale = useCallback((id, scale) => {
        setLayout((l) => {
            const next = cleanScale(scale);
            if ((l.sections[id]?.scale || 0) === next) return l;
            return { ...l, sections: { ...l.sections, [id]: { ...l.sections[id], scale: next } } };
        });
    }, []);

    const setSectionHidden = useCallback((id, hidden) => {
        // The one panel that cannot be hidden. It is the panel that unhides the others,
        // so hiding it is a door locked from the inside: nothing left on screen offers
        // the way back, and the only cure is clearing the layout out of localStorage.
        //
        // Refused here rather than only left out of the menus, because there are three
        // ways to ask — the section header, a floating window's menu, and the Layout
        // panel's own list — and a rule enforced in three places is a rule that will be
        // missed by the fourth.
        if (hidden && id === UNHIDEABLE) return;
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

    // Drops a panel next to another one, which is what a drag within a dock is.
    // See insertNear for why this takes the neighbour rather than an index.
    const movePanelNear = useCallback((id, dock, anchorId, edge) => {
        setLayout((l) => {
            // Dropped on itself: nothing to do, and nothing to write. This is
            // also the guard that stops the panel being lost — see below.
            if (!id || id === anchorId || !DOCKS.includes(dock)) return l;
            const docks = {};
            for (const d of DOCKS) {
                // Every dock but the target loses the panel here. The target
                // keeps it and insertNear does the removal, so the list it works
                // on is the one it documents: remove, then find the anchor. If
                // the id were stripped here too, a call anchored on the panel
                // itself would return a list without it — and the panel would
                // vanish from the layout altogether.
                docks[d] = d === dock
                    ? { ...l.docks[d] }
                    : { ...l.docks[d], panels: l.docks[d].panels.filter((p) => p !== id) };
            }
            const floats = { ...l.floats };
            delete floats[id];
            docks[dock] = {
                ...docks[dock],
                panels: insertNear(docks[dock].panels, id, anchorId, edge),
                collapsed: false,
            };
            return {
                ...l,
                docks,
                floats,
                floatOrder: l.floatOrder.filter((f) => f !== id),
                sections: { ...l.sections, [id]: { ...l.sections[id], hidden: false } },
            };
        });
    }, []);

    // Swaps two panels that share a dock — the arrows in a docked panel's
    // header, moving it one place along the order.
    //
    // Takes the neighbour's id rather than an index because the header only
    // knows what is on screen: a dock's list may also hold panels that are
    // hidden, or that do not apply to this server, and stepping past one of
    // those would look like an arrow that did nothing. Swapping two visible
    // panels leaves whatever sits between them where it is.
    const swapPanels = useCallback((a, b) => {
        setLayout((l) => {
            if (!a || !b || a === b) return l;
            const dock = DOCKS.find((d) => l.docks[d].panels.includes(a));
            if (!dock || !l.docks[dock].panels.includes(b)) return l;
            const panels = [...l.docks[dock].panels];
            const i = panels.indexOf(a);
            const j = panels.indexOf(b);
            panels[i] = b;
            panels[j] = a;
            return { ...l, docks: { ...l.docks, [dock]: { ...l.docks[dock], panels } } };
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

    // Any geometry change settles a seeded window's anchor: the anchor exists
    // only to say where it should first appear, and once it has a real position
    // — placed by the layer or dragged by hand — keeping it would move the
    // window back to the corner on the next resize.
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
            delete next.anchor;
            if (!cur.anchor && next.x === cur.x && next.y === cur.y
                && next.w === cur.w && next.h === cur.h) return l;
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

    // Pin the top panel of a side dock, or unpin it.
    //
    // One pin per dock, so "which panel" and "whether" are the same fact and a
    // second pin is not something that can be asked for. Clicking the lit button
    // is the only thing that clears one: a pin on a panel that has been moved
    // down simply stops applying — see pinnedPanel — and applies again if it
    // comes back to the top, which is what makes a reorder reversible rather
    // than something that quietly forgot the setting.
    const togglePin = useCallback((side, id) => {
        setLayout((l) => {
            if (!PINNABLE.includes(side) || !id) return l;
            const pins = { left: null, right: null, ...l.pins };
            const next = pins[side] === id ? null : id;
            if (pins[side] === next) return l;
            return { ...l, pins: { ...pins, [side]: next } };
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
        pins: layout.pins,
        togglePin,
        setFloat,
        setFloatMin,
        raiseFloat,
        placementOf,
        toggleDock,
        setDockCollapsed,
        setDockSize,
        toggleSection,
        toggleSectionMinimal,
        setSectionScale,
        setSectionHidden,
        movePanel,
        movePanelNear,
        swapPanels,
        revealPanel,
        resetLayout,
    }), [layout, toggleDock, setDockCollapsed, setDockSize, toggleSection, toggleSectionMinimal, setSectionScale, setSectionHidden, movePanel, movePanelNear,
        swapPanels, revealPanel, setFloat, setFloatMin, raiseFloat, placementOf, setWeights, setPanelHeight, togglePin, resetLayout]);

    return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
}

export function useLayout() {
    const ctx = useContext(LayoutContext);
    if (!ctx) throw new Error('useLayout outside LayoutProvider');
    return ctx;
}
