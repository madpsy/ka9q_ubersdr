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
    POLL_MS, confirmedUrl, freqLabel, normaliseSpot, tuneTarget,
} from './voiceSkimmer.js';
import { tuneAction } from './noticeActions.js';
import { feedInterval, setFeedsAllowed } from './serverFeeds.js';
import { pushNotification, sourceEnabled } from './notifications.js';
import { countryFlag } from './format.js';

// How many sightings to hold. The bar draws only what fits the visible window and drops
// the rest, so this is "enough that a wide view is not obviously short" rather than a
// display limit — the addon holds a few dozen across all bands in normal use.
export const MARKER_ROWS = 50;

// How many new callsigns are announced one by one before the poll says so as a count
// instead. Three is the toast layer's own limit, so a fourth would push the first off the
// screen unread — a burst that arrives as four toasts is one that arrives as three.
export const ANNOUNCE_MAX = 3;

// How many callsigns are remembered as already announced. The list itself is fifty rows,
// so this is a few hours of a busy skimmer: long enough that a station heard on and off
// all evening is announced once, bounded so a page left open for a week does not grow.
export const ANNOUNCED_MAX = 500;

const subscribers = new Set();
// The feedInterval stop function, not a timer id. See lib/serverFeeds.js.
let timer = null;
let latest = null;
let inFlight = false;
// Which callsigns have been announced, and whether there is a baseline to compare
// against yet. See announce.
const announced = new Set();
let baselined = false;

function notify() {
    for (const fn of Array.from(subscribers)) {
        try { fn(latest); } catch (err) { console.error('confirmed voice subscriber threw', err); }
    }
}

/**
 * One sighting as a notification: the flag, the callsign and where it was heard.
 *
 * The flag rather than the country in the heading because a toast is read at a glance and
 * a flag is the fastest thing on it to recognise — but the country name is in the body
 * underneath, because the flags this hears most are exactly the ambiguous ones. The
 * country and its code both come from the addon, which has already resolved the DXCC
 * entity; deriving either here would be a second answer that could disagree. See
 * normaliseSpot.
 *
 * Keyed by callsign, so the same station heard again replaces its own line rather than
 * stacking on it — belt and braces against the announced set, which is what normally
 * stops a repeat from ever getting this far.
 *
 * And pressable: this is a notification that names a frequency, so the thing anybody wants
 * on reading it is to be there. The target is tuneTarget's, the same one clicking the
 * callsign in the panel uses — mode included where the addon reported one, omitted rather
 * than guessed where it did not.
 */
export function callsignNotice(spot) {
    const flag = countryFlag(spot.cc);
    return {
        severity: 'info',
        source: 'voice-callsign',
        title: flag ? `${flag} ${spot.callsign}` : spot.callsign,
        body: [`${freqLabel(spot.hz)} MHz`, spot.band, spot.country].filter(Boolean).join(' · '),
        key: `voice-callsign-${spot.callsign}`,
        action: tuneAction(tuneTarget(spot)),
    };
}

/** "🇬🇧 MM3NDH", or the callsign alone where the addon reported no country. */
const tag = (s) => (countryFlag(s.cc) ? `${countryFlag(s.cc)} ${s.callsign}` : s.callsign);

/**
 * Announce the callsigns in this list that have not been announced before.
 *
 * Three things have to be true of this or it is worse than not having it:
 *
 *   The first list is a baseline, never an announcement. It is fifty stations the skimmer
 *   heard before the page was opened, and greeting somebody with fifty toasts about things
 *   that happened while they were away is the whole failure mode this guards.
 *
 *   The announced set moves whether or not anybody is listening. Switching the source on
 *   is then a statement about what happens next, rather than a burst about everything
 *   heard while it was off — which is the same list, and the same wall of toasts.
 *
 *   A burst is a count. A skimmer that has just come back from a gap can confirm a dozen
 *   at once, and the toast layer holds three: announcing each would be announcing three of
 *   them and silently dropping the rest.
 *
 * Deduplicated by callsign rather than by the sighting's own key, which carries the
 * frequency: a station that moves 200 Hz between two polls is not news, and it is the
 * callsign that is new here, not the place it was heard.
 */
function announce(spots) {
    // Newest first, as the query sorted them.
    const fresh = spots.filter((s) => s.callsign && !announced.has(s.callsign));
    for (const s of spots) announced.add(s.callsign);
    // Oldest out first — a Set iterates in insertion order, and deleting while iterating
    // one is defined behaviour.
    if (announced.size > ANNOUNCED_MAX) {
        let over = announced.size - ANNOUNCED_MAX;
        for (const c of announced) {
            if (over-- <= 0) break;
            announced.delete(c);
        }
    }

    if (!baselined) {
        baselined = true;
        return;
    }
    // Checked after the set has moved, deliberately: see above.
    if (!fresh.length || !sourceEnabled('voice-callsign')) return;

    if (fresh.length > ANNOUNCE_MAX) {
        const named = fresh.slice(0, ANNOUNCE_MAX).map(tag).join(', ');
        pushNotification({
            severity: 'info',
            source: 'voice-callsign',
            title: `${fresh.length} new callsigns`,
            body: `${named} and ${fresh.length - ANNOUNCE_MAX} more`,
            key: 'voice-callsign-burst',
        });
        return;
    }
    // Oldest first, so the newest sighting ends up on top of the stack: each toast is
    // pushed in front of the last.
    for (let i = fresh.length - 1; i >= 0; i--) pushNotification(callsignNotice(fresh[i]));
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
            announce(latest);
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
    announced.clear();
    baselined = false;
}
