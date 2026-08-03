// One accumulating store per spot feed, shared by the Spots panel and the
// marker bar.
//
// Same shape as the voice activity poll in lib/voiceActivity.js and for the
// same reasons: two consumers want the same data, the subscription is not free,
// and both of them come and go — the panel is unmounted while its section is
// collapsed or dragged between docks, and the markers sit behind a toggle. So
// the stream is acquired on the first subscriber and released with the last,
// and the accumulated list outlives any one component.
//
// This is also what stops a dock drag from emptying the panel: the spots live
// here, not in the panel's state.

import { dxcluster } from '../radio/dxcluster-connection.js';
import { MAX_SPOTS, NORMALISE, addSpot } from './spots.js';

// Stream names on the socket, per feed.
const STREAM = { dx: 'dx_spots', digital: 'digital_spots', cw: 'cw_spots' };
// The event each feed arrives on.
const EVENT = { dx: 'dx_spot', digital: 'digital_spot', cw: 'cw_spot' };

const feeds = {};

function feed(kind) {
    if (!feeds[kind]) {
        feeds[kind] = { subscribers: new Set(), spots: [], off: null, release: null };
    }
    return feeds[kind];
}

function emit(f) {
    for (const fn of f.subscribers) {
        try { fn(f.spots); } catch (err) { console.error('spot subscriber threw', err); }
    }
}

// Subscribes to a feed. `fn` is called with the whole list on every new spot,
// and immediately with what is already held so a panel opening mid-stream
// renders at once rather than waiting for the next spot — which on a quiet band
// could be minutes.
export function subscribeSpots(kind, fn) {
    const f = feed(kind);
    f.subscribers.add(fn);

    if (f.subscribers.size === 1) {
        const normalise = NORMALISE[kind];
        const cap = MAX_SPOTS[kind];
        f.off = dxcluster.on(EVENT[kind], (raw) => {
            const next = addSpot(f.spots, normalise(raw), cap);
            // addSpot returns the same list when the spot is already held —
            // every subscribe replays the server's buffer, so this is the
            // common case on reconnect and must not re-render everyone.
            if (next === f.spots) return;
            f.spots = next;
            emit(f);
        });
        // Acquiring is what makes the server send anything; it also replays the
        // buffer, which is how a fresh subscriber gets history.
        f.release = dxcluster.acquire(STREAM[kind]);
    }

    try { fn(f.spots); } catch (err) { console.error('spot subscriber threw', err); }

    return () => {
        if (!f.subscribers.delete(fn)) return;
        if (f.subscribers.size > 0) return;
        if (f.off) { f.off(); f.off = null; }
        if (f.release) { f.release(); f.release = null; }
        // The list is deliberately kept. Re-subscribing replays the server's
        // buffer anyway, but holding what we have means reopening the panel
        // shows the spots immediately instead of blank until the replay lands.
    };
}

export function spotsFor(kind) {
    return feed(kind).spots;
}

export function clearSpots(kind) {
    const f = feed(kind);
    f.spots = [];
    emit(f);
}

// Test seam.
export function _resetSpotStore() {
    for (const kind of Object.keys(feeds)) {
        const f = feeds[kind];
        if (f.off) f.off();
        if (f.release) f.release();
        delete feeds[kind];
    }
}
