// Confirmed voice callsigns as markers: who has actually been identified, and where.
//
// The voice skimmer's left-hand column — heard on SSB, extracted from the transcript
// and validated — put on the bar. It is the one marker layer that carries a *name*
// rather than a place: a bookmark says somebody thought this frequency was worth
// keeping, voice activity says the detector heard speech in the last ninety seconds,
// and this says a station identified itself and the addon believed it.
//
// Which is why it is worth its own layer rather than being folded into the voice
// activity one. Those two markers answer different questions and go stale at wildly
// different rates — ninety seconds against however long the skimmer keeps a sighting —
// so a single layer would have to pick one meaning and lose the other.
//
// One poll for the whole page, started by the first subscriber and stopped when the
// last one goes, and gated with the rest of the app's feeds — the same shape as the
// packet marker and voice activity stores.
//
// Its query is not the panel's. The panel asks for five rows on the band the picker is
// set to; the bar needs every band, because it draws whatever falls inside the window
// the spectrum happens to be showing, and a band filter would blank it the moment you
// tuned somewhere the picker was not pointed at. So this is a second request rather
// than a shared one — the same 30 s cadence, and only while something is drawing it.

import {
    POLL_MS, confirmedUrl, normaliseSpot,
} from './voiceSkimmer.js';
import { feedInterval, setFeedsAllowed } from './serverFeeds.js';

// How many sightings to hold. The bar draws only what fits the visible window and drops
// the rest, so this is "enough that a wide view is not obviously short" rather than a
// display limit — the addon holds a few dozen across all bands in normal use.
export const MARKER_ROWS = 50;

const subscribers = new Set();
// The feedInterval stop function, not a timer id. See lib/serverFeeds.js.
let timer = null;
let latest = null;
let inFlight = false;

function notify() {
    for (const fn of Array.from(subscribers)) {
        try { fn(latest); } catch (err) { console.error('confirmed voice subscriber threw', err); }
    }
}

function load() {
    if (inFlight) return;
    inFlight = true;
    fetch(confirmedUrl(MARKER_ROWS, 'all'))
        .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        })
        .then((payload) => {
            const rows = (payload && payload.spots) || [];
            latest = rows.map(normaliseSpot).filter((s) => s && s.hz);
            notify();
        })
        .catch(() => {
            // The addon has gone away, or was never there. The last list stays on the
            // bar rather than blinking out on one failed poll — these are stations that
            // were heard, and they were still heard whatever the addon is doing now.
        })
        .finally(() => { inFlight = false; });
}

/** The sightings as they stand, for a caller that cannot wait for the next poll. */
export const confirmedVoice = () => latest || [];

/**
 * Subscribe. `fn` is called with what is already known if anything is, and again on
 * every refresh. Returns the unsubscribe.
 */
export function subscribeConfirmedVoice(fn) {
    subscribers.add(fn);
    // Replayed, so a bar that mounts mid-cycle draws what is already known rather than
    // nothing for half a minute.
    if (latest) {
        try { fn(latest); } catch (err) { console.error('confirmed voice subscriber threw', err); }
    }
    if (timer === null) timer = feedInterval(load, POLL_MS);
    return () => {
        subscribers.delete(fn);
        if (subscribers.size === 0 && timer !== null) {
            timer();
            timer = null;
        }
    };
}

/** Test seam. */
export function _resetConfirmedVoice() {
    // A store under test polls: the feed gate is the receiver's business and has its
    // own tests. See lib/serverFeeds.js, and the other stores' seams.
    setFeedsAllowed(true);
    subscribers.clear();
    if (timer !== null) timer();
    timer = null;
    latest = null;
    inFlight = false;
}
