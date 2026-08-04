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

// Starts a lookup if this callsign has never been asked about. The result
// arrives through onLookupResolved; peekLookup reads it.
export function startLookup(callsign, uuid) {
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
        .catch(() => {
            // No result, or the service is off. Cached as a miss so the dial
            // passing over this spot again does not ask a second time.
            resolved(call, null);
        }));
}

export function _resetLookups() {
    cache.clear();
    pending.clear();
}
