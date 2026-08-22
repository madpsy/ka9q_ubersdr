// A published manifest, turned into a registry entry.
//
// The manifest comes off a collector shared by every receiver, written by
// somebody else, and reaches this file before the first render — `PANELS` is
// read at module init and `LayoutProvider` reconciles against it immediately.
// So the one rule here is that **nothing throws**. A field that cannot be used
// falls back; a manifest that cannot be used at all costs exactly one panel.
// Anything that threw would be a white screen for the whole receiver, over
// somebody else's typo.
//
// What the server checked is narrow and deliberate: that the bundle parses, and
// that its `ui` and `schema` are ones this build runs (panels_api.go). Every
// other field arrives unexamined, which is the right split — a server with
// opinions about `icon` would be a second place to change every time this grows.

import { PANEL_ICONS, panelIcon } from './icons.jsx';

// The docks a manifest may name. Deliberately a local literal rather than an
// import of `DOCKS` from layout/LayoutContext.jsx: that module imports the
// registry, the registry imports this one, and closing that cycle would leave
// `DOCKS` in its temporal dead zone at module init — where this runs. The build
// and the tests would both pass and the interface would come up blank.
const VALID_DOCKS = ['left', 'right', 'bottom'];

// The prefix the server hands out, mirrored here so the check is local to the
// code that relies on it. A custom panel can never collide with `receiver` or
// `layout`: the namespace is not something a manifest can opt out of.
const ID_PREFIX = 'x:';

// Bounds on the numbers a manifest may set. Not taste — a `weight` of 10000
// would collapse every neighbour in the bottom dock to nothing, and a `height`
// of zero would make a panel unclickable.
const WEIGHT = { min: 0.1, max: 4 };
const HEIGHT = { min: 60, max: 2000 };

const isString = (v) => typeof v === 'string' && v.trim() !== '';

function clampNumber(v, { min, max }) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.min(max, Math.max(min, n));
}

/**
 * One listing from `/api/v2/panels`, as a registry entry.
 *
 * Returns null only when there is nothing usable at all — no id, or an id that
 * is not one of ours. Everything else degrades.
 *
 * `makeComponent(entry)` supplies the body, rather than this module building it:
 * this file knows about manifests, and what a panel is *drawn* by is the
 * caller's business. It takes the finished entry so the component can be handed
 * its own panel — the dock renders `<panel.Component minimal={…} />` and passes
 * nothing else, so provenance and manifest have to be bound in here.
 */
export function panelEntry(listing, makeComponent) {
    if (!listing || typeof listing !== 'object') return null;
    const id = listing.id;
    if (!isString(id) || !id.startsWith(ID_PREFIX)) return null;

    const m = (listing.manifest && typeof listing.manifest === 'object') ? listing.manifest : {};

    const entry = {
        id,
        // The id is the last resort, not a good title, but a panel with a
        // missing one still has to be nameable in the layout manager.
        title: isString(m.title) ? m.title.trim() : id,
        icon: panelIcon(m.icon),
        dock: VALID_DOCKS.includes(m.dock) ? m.dock : 'left',
        defaultOpen: m.defaultOpen !== false,
        defaultHidden: m.defaultHidden === true,
        minimal: m.minimal === true,
        fill: m.fill === true,
        // Where a phone puts it. Unknown or missing is not an error: the mobile
        // shell already rides anything ungrouped along with the last group, so
        // the panel stays reachable either way. See panels/groups.jsx.
        group: isString(m.group) ? m.group.trim() : null,
        // Provenance, for the row in the layout manager that carries the switch
        // turning this panel off. "Who wrote this and what is it" is a fair
        // question to ask of code that came off a shared collector.
        custom: {
            name: isString(listing.name) ? listing.name : null,
            callsign: isString(listing.callsign) ? listing.callsign : null,
            description: isString(listing.description) ? listing.description : null,
            version: Number.isFinite(Number(listing.version)) ? Number(listing.version) : null,
        },
    };

    const weight = clampNumber(m.weight, WEIGHT);
    if (weight !== null) entry.weight = weight;
    const height = clampNumber(m.height, HEIGHT);
    if (height !== null) entry.height = height;

    entry.Component = typeof makeComponent === 'function' ? makeComponent(entry) : makeComponent;
    return entry;
}

/**
 * A whole listing, as registry entries.
 *
 * Duplicate ids are dropped rather than merged, and an id that matches a
 * built-in panel is dropped too: `PANEL_BY_ID` is a map, so a second entry would
 * silently shadow the first — and if the first were the Layout panel, the way
 * back would go with it. The namespace makes that impossible in practice; the
 * check is here because "in practice" is not a guarantee.
 */
export function panelEntries(listings, makeComponent, taken = new Set()) {
    const out = [];
    const seen = new Set(taken);
    for (const listing of Array.isArray(listings) ? listings : []) {
        const entry = panelEntry(listing, makeComponent);
        if (!entry || seen.has(entry.id)) continue;
        seen.add(entry.id);
        out.push(entry);
    }
    return out;
}

export { PANEL_ICONS };
