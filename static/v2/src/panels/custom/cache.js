// What the registry is built from, and why it is read synchronously.
//
// Custom panels arrive over the network, and the registry is read before the
// first render: `PANELS` is evaluated at module init and `LayoutProvider` — the
// outermost provider in App.jsx — reconciles a stored layout against it
// immediately. A panel the registry does not know at that moment is one the
// layout has no entry for.
//
// `reconcile()` no longer destroys such an entry (it parks it, see
// layout/LayoutContext.jsx), so a slow fetch is survivable rather than
// catastrophic. But parked is not the same as *present*: a parked panel is not
// drawn, does not appear in the layout manager and has no mobile tab. So the
// registry wants its manifests before the first frame, not a moment later.
//
// Hence a store of its own, on the pattern bridge/settings.js and lib/announce.js
// already use: read from localStorage at module init, revalidated from
// /api/v2/panels afterwards.
//
// The timing works out exactly. A stored layout can only mention a custom panel
// if some earlier load knew about it — and that load also wrote this cache. So
// the seed holds precisely what there is something to protect. On a first-ever
// load the cache is empty, but so is the stored layout, and there is nothing to
// lose. No blocking fetch before `root.render()`, and no round-trip added to
// startup.
//
// localStorage rather than IndexedDB, and this one is not a preference: the
// whole job is to be readable *synchronously* before the first render, which
// IndexedDB cannot do. Panel *data* — what a panel stores for itself — is a
// different question with a different answer; see CUSTOM_PANELS.md §5.3.

const STORAGE_KEY = 'ubersdr.v2.panels';
const ENDPOINT = '/api/v2/panels';

// A ceiling on what will be seeded from a store this receiver does not control.
// The server caps the enabled set at ten; this is that with room to spare, and
// it stops a corrupted or hand-edited entry turning into an unbounded registry.
const MAX_PANELS = 32;

let current = null;
let etag = null;
const listeners = new Set();

/** Only the shape the registry needs, and nothing that is not a listing. */
function clean(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const p of list) {
        if (!p || typeof p !== 'object') continue;
        if (typeof p.id !== 'string' || !p.id.startsWith('x:')) continue;
        out.push(p);
        if (out.length >= MAX_PANELS) break;
    }
    return out;
}

function load() {
    try {
        return clean(JSON.parse(localStorage.getItem(STORAGE_KEY)));
    } catch (e) {
        // Private mode, blocked site data, or a half-written value. An empty
        // registry is a receiver with no custom panels, which is a state it has
        // to handle anyway.
        return [];
    }
}

/** The cached listings, synchronously. Safe to call at module init. */
export function cachedPanels() {
    if (!current) current = load();
    return current;
}

/** The ids currently known to be enabled — what `requires` asks about. */
export function panelIds() {
    return new Set(cachedPanels().map((p) => p.id));
}

/**
 * The version of one panel, or null if this receiver no longer serves it.
 *
 * What a mounted frame watches. The registry entry it was built from is frozen
 * at module init and carries the version that was current *then*, so a panel
 * whose author has published since would otherwise go on running the old bundle
 * until somebody reloaded the page.
 */
export function panelVersion(id) {
    for (const p of cachedPanels()) {
        if (p.id === id) return Number(p.version) || 0;
    }
    return null;
}

export function onPanels(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function publish(list) {
    current = clean(list);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch (e) { /* private mode */ }
    for (const fn of Array.from(listeners)) fn(current);
    return current;
}

/**
 * Fetch the enabled set and revalidate the cache.
 *
 * A 304 means nothing has changed and the cache stands. A request that *failed*
 * — offline, a timeout, a 5xx, a proxy returning HTML — leaves the cache alone
 * as well: the panels an operator enabled do not stop existing because one
 * request failed.
 *
 * A 404 is neither of those, and treating it as a failure was a bug. It is the
 * receiver answering: there is no such endpoint here, so there are no custom
 * panels here. Keeping a list across that answer only matters when the list came
 * from somewhere else — and it can, because the desktop and mobile clients share
 * settings between receivers, so an arrangement made on the receiver that has a
 * panel is carried to the one that does not. The stale entry then passes the
 * gate in registry.jsx (which asks this cache what is enabled), the panel is
 * drawn, and its body 404s too: "This panel could not be loaded", permanently,
 * on a receiver that never had it.
 *
 * Clearing is safe in the way the old comment feared it was not. A layout entry
 * for a panel the registry does not know is *parked*, not destroyed — see
 * reconcile() in layout/LayoutContext.jsx — so going back to the receiver that
 * does serve the panel puts it back where it was.
 */
const GONE = new Set([404, 410]);

export async function refreshPanels() {
    try {
        const headers = etag ? { 'If-None-Match': etag } : undefined;
        const res = await fetch(ENDPOINT, { headers, cache: 'no-store' });
        if (res.status === 304) return cachedPanels();
        // The receiver has answered, and the answer is "nothing". Note the etag
        // goes too: whatever it was validating is not on this receiver.
        if (GONE.has(res.status)) {
            etag = null;
            return publish([]);
        }
        if (!res.ok) return cachedPanels();

        const body = await res.json();
        etag = res.headers.get('ETag') || (body && body.etag) || null;
        return publish(body && body.panels);
    } catch (e) {
        return cachedPanels();
    }
}

// How often the page asks whether the enabled set has changed.
//
// The server re-checks the collector every fifteen minutes, so this only has to
// be short enough that an operator enabling a panel does not feel like nothing
// happened. The ETag makes it a 304 in the ordinary case, which is a few dozen
// bytes.
export const POLL_MS = 120000;

/**
 * Keep the cache current for as long as the page is open.
 *
 * Two rules, and both are about not asking when there is no point. A hidden tab
 * is not looking at any panel, so it does not poll; and a tab that has just been
 * looked at again asks immediately rather than waiting out the rest of an
 * interval that ran while nobody was there.
 *
 * Self-rescheduling rather than an interval: a slow or hanging answer must not
 * let requests stack up behind it.
 */
export function startPanelPolling(opts = {}) {
    const every = opts.intervalMs || POLL_MS;
    const set = (opts.timers && opts.timers.set) || ((fn, ms) => setTimeout(fn, ms));
    const clear = (opts.timers && opts.timers.clear) || ((h) => clearTimeout(h));
    const isHidden = opts.isHidden || (() => typeof document !== 'undefined' && !!document.hidden);
    const refresh = opts.refresh || refreshPanels;

    let timer = null;
    let stopped = false;

    const arm = () => {
        if (stopped) return;
        clear(timer);
        timer = set(tick, every);
    };

    async function tick() {
        if (stopped) return;
        if (!isHidden()) await refresh();
        arm();
    }

    const onVisible = () => {
        if (stopped || isHidden()) return;
        refresh();
        arm();
    };

    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('visibilitychange', onVisible);
    }
    arm();

    return function stop() {
        stopped = true;
        clear(timer);
        if (typeof document !== 'undefined' && document.removeEventListener) {
            document.removeEventListener('visibilitychange', onVisible);
        }
    };
}

// Testing seam: the store lives for the whole session by design, so a test that
// wants a second opinion has to be able to say so.
export function resetPanelCache(list) {
    current = clean(list || []);
    etag = null;
}
