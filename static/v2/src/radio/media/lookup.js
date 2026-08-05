// Callsign lookups for the lock screen.
//
// Separate from the panel's own lookup because the two want different things
// and at different times: the panel looks up what you clicked and shows
// everything, this looks up whatever the dial happens to be sitting on and
// wants three fields. What they do share is the server's 24-hour cache, so the
// second request for a callsign costs nothing either way.
//
// Cached here for the life of the page, negative results included — the dial
// crosses the same spot repeatedly while tuning around, and re-requesting a
// callsign the provider has never heard of would spend the per-IP rate limit on
// nothing.

import { lookupCallsignData, normaliseCallsign } from '../../lib/callsign.js';

const cache = new Map();     // callsign -> { firstName, country, photo } | null
const pending = new Map();   // callsign -> Promise
const listeners = new Set();
const retries = new Set();   // timers for the one retry below

// Long enough for the audio session to be registered, short enough that the
// name appears while the operator is still looking at the station.
const RETRY_MS = 2000;

// Fires when a lookup lands, so the metadata can be pushed again with the
// operator's name and photo — they arrive after the tuning change that asked
// for them, and the OS has already drawn the old card by then.
export function onLookupResolved(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function resolved(call, value) {
    cache.set(call, value);
    pending.delete(call);
    for (const fn of listeners) {
        try { fn(call, value); } catch (err) { console.error('lookup listener threw', err); }
    }
}

// What is known now, or null. Pure — safe to call on every render.
export function peekLookup(callsign) {
    const call = normaliseCallsign(callsign);
    return (call && cache.get(call)) || null;
}

/**
 * Starts a lookup if this callsign has never been asked about. The result
 * arrives through onLookupResolved; peekLookup reads it.
 *
 * A failure that was not a verdict on the callsign is retried once, because the
 * caller will not retry for us: the Markers panel asks in an effect keyed on
 * which marker is selected, so a lookup lost to the startup race would leave the
 * operator's name blank until the dial moved to another station and back.
 */
export function startLookup(callsign, uuid, { retry = true } = {}) {
    const call = normaliseCallsign(callsign);
    if (!call) return;
    if (cache.has(call) || pending.has(call) || !uuid) return;

    pending.set(call, lookupCallsignData(call, uuid)
        .then((data) => {
            resolved(call, {
                firstName: (data.fname || '').trim(),
                country: (data.country || '').trim(),
                // Already a same-origin path (/api/lookup/image/<uuid>) — the
                // server proxies the provider's CDN, which is what lets the
                // artwork be fetched into a blob at all.
                photo: (data.image || '').trim(),
            });
        })
        .catch((err) => {
            if (err && err.retryable) {
                // Could not ask, rather than asked and told no. Dropped without
                // being cached: the common case is the Markers panel asking the
                // instant the receiver starts, before the server has registered
                // the audio session, and remembering that as "no such station"
                // would blank this callsign for the life of the page.
                pending.delete(call);
                if (!retry) return;
                const timer = setTimeout(() => {
                    retries.delete(timer);
                    startLookup(call, uuid, { retry: false });
                }, RETRY_MS);
                // Never a reason to hold a test runner or a closing page open.
                if (timer.unref) timer.unref();
                retries.add(timer);
                return;
            }
            // Asked, and there is no such station. Cached as a miss so the dial
            // passing over this spot again does not ask a second time.
            resolved(call, null);
        }));
}

export function _resetLookups() {
    cache.clear();
    pending.clear();
    for (const timer of retries) clearTimeout(timer);
    retries.clear();
}
