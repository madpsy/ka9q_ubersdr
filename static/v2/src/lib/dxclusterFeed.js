// The live half: history, the event stream, and the addon's status.
//
// Separate from dxcluster.js so the rules there stay a pure function of a spot
// and can be tested without a network. This part is all lifecycle, and it has
// exactly one: `open()` returns a handle, `close()` ends it, and nothing is
// started until a panel asks.

import { BASE, spotKey } from './dxcluster.js';

// Newest first, and bounded. The widget keeps 2000; the same number here costs
// a couple of megabytes at worst and keeps a morning's spots scrollable.
export const MAX_SPOTS = 2000;

const STREAM_IDS = ['dxcluster', 'decoder', 'cwskimmer', 'voice'];

/**
 * @param on.spots   (spots) => void — the whole list, newest first, on change
 * @param on.status  (status) => void — /api/status, refreshed on a slow poll
 * @param on.state   ('connecting'|'live'|'down') => void
 */
export function openFeed(on = {}) {
    let spots = [];
    const seen = new Set();
    let es = null;
    let statusTimer = null;
    let closed = false;
    // Coalesced: a busy cluster arrives faster than anyone can read, and one
    // render per spot would be the panel's whole frame budget.
    let pending = false;

    const emit = () => {
        pending = false;
        if (!closed && on.spots) on.spots(spots);
    };
    const schedule = () => {
        if (pending || closed) return;
        pending = true;
        setTimeout(emit, 120);
    };

    function add(list, live) {
        let added = 0;
        for (const spot of list) {
            const key = spotKey(spot);
            if (seen.has(key)) continue;
            seen.add(key);
            spots.unshift(spot);
            added++;
        }
        if (!added) return;
        if (spots.length > MAX_SPOTS) {
            for (const gone of spots.slice(MAX_SPOTS)) seen.delete(spotKey(gone));
            spots = spots.slice(0, MAX_SPOTS);
        }
        if (live) schedule(); else emit();
    }

    async function loadHistory() {
        // Each stream separately, as the addon serves them, and oldest first so
        // the merged list ends up newest-first like the live feed.
        const lists = await Promise.all(STREAM_IDS.map(async (stream) => {
            try {
                const r = await fetch(`${BASE}/api/spots?stream=${stream}`);
                if (!r.ok) return [];
                const rows = await r.json();
                return Array.isArray(rows) ? rows : [];
            } catch (e) {
                return [];
            }
        }));
        if (closed) return;
        const merged = lists.flat().sort(
            (a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')),
        );
        add(merged, false);
    }

    async function loadStatus() {
        try {
            const r = await fetch(`${BASE}/api/status`);
            if (!r.ok || closed) return;
            const s = await r.json();
            if (!closed && on.status) on.status(s);
        } catch (e) {
            /* the panel keeps the last reading */
        }
    }

    function connect() {
        if (closed || typeof EventSource === 'undefined') return;
        if (on.state) on.state('connecting');
        es = new EventSource(`${BASE}/api/events`);
        es.addEventListener('message', (e) => {
            try {
                add([JSON.parse(e.data)], true);
            } catch (err) { /* not a spot */ }
        });
        // The addon sends these on a timer whether or not anything is being
        // spotted, which is the only way to tell a quiet band from a dead feed.
        es.addEventListener('heartbeat', () => { if (on.state) on.state('live'); });
        es.onopen = () => { if (on.state) on.state('live'); };
        es.onerror = () => {
            // EventSource reconnects on its own; say so rather than tearing it
            // down and racing it with a reconnect of our own.
            if (on.state) on.state('down');
        };
    }

    loadHistory();
    loadStatus();
    connect();
    statusTimer = setInterval(loadStatus, 15000);

    return {
        close() {
            closed = true;
            clearInterval(statusTimer);
            if (es) es.close();
            es = null;
        },
        /** Test seam and the panel's "clear" button. */
        clear() {
            spots = [];
            seen.clear();
            emit();
        },
    };
}
