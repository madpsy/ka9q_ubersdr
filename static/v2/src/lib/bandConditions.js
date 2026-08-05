// How each amateur band is doing, from the FT8 traffic the receiver has heard.
//
// One poll for everyone who colours a band button. The Quick bands panel and
// the Multipad's band row draw the same ten buttons from the same endpoint, and
// two components polling /api/noisefloor/aggregate on their own timers would ask
// twice for one answer and then disagree about it for up to a minute at a time.
//
// Same shape as lib/spotStore.js and for the same reasons: acquired on the first
// subscriber, released with the last, and the last answer outlives any one
// component — so a panel reopened after a dock drag, or a sheet swapped back to
// on a phone, paints its colours at once instead of sitting grey until the next
// minute comes round.
//
// The thresholds and the averaging are v1's (static/bands_state.js and app.js),
// so both frontends call the same band the same colour.

import { BAND_NAMES } from './bands.js';

export const POLL_MS = 60 * 1000;
export const WINDOW_MIN = 10;      // minutes of history averaged

/** v1's buckets. */
export function classify(snr) {
    if (snr < 6) return 'POOR';
    if (snr < 20) return 'FAIR';
    if (snr < 30) return 'GOOD';
    return 'EXCELLENT';
}

/** Average ft8_snr per band over the returned window, as v1 does. */
export function summarise(primary) {
    const out = {};
    for (const band of BAND_NAMES) {
        const points = (primary || {})[band];
        let total = 0;
        let n = 0;
        for (const p of points || []) {
            const v = p.values && p.values.ft8_snr;
            if (v != null) { total += v; n++; }
        }
        out[band] = n ? { status: classify(total / n), snr: total / n } : { status: 'UNKNOWN', snr: null };
    }
    return out;
}

/**
 * What a button should look like, from a band's entry.
 *
 * A receiver with no noise floor monitor has no conditions at all, and one that
 * simply has not heard FT8 on a band yet has none for that band. v1 draws both
 * as open rather than greying them out — an instance without history still
 * reads as a set of bands you can go to — so the two cases differ only in
 * whether there is a reading to put in the tooltip.
 */
export function bandTone(state, conditions) {
    if (!conditions) return 'none';
    if (!state || state.status === 'UNKNOWN') return 'excellent';
    return state.status.toLowerCase();
}

/** The tooltip for a band button. */
export function bandTip(name, state, conditions) {
    if (!conditions) return name;
    return state && state.snr != null
        ? `${name}: ${state.status}\nFT8 SNR: ${state.snr.toFixed(2)} dB`
        : `${name}: No data available`;
}

/** The request body, so the window and the fields are asked for in one place. */
export function requestBody(to = new Date()) {
    const from = new Date(to.getTime() - WINDOW_MIN * 60 * 1000);
    return {
        primary: { from: from.toISOString(), to: to.toISOString() },
        bands: BAND_NAMES,
        fields: ['ft8_snr'],
        interval: 'minute',
    };
}

// ---------------------------------------------------------------------------

let states = {};
const subscribers = new Set();
let timer = null;

export function getBandConditions() {
    return states;
}

function emit() {
    for (const fn of subscribers) {
        try { fn(states); } catch (err) { console.error('band conditions subscriber threw', err); }
    }
}

function load() {
    fetch('/api/noisefloor/aggregate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody()),
    })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
            if (!d) return;
            states = summarise(d.primary);
            emit();
        })
        .catch(() => { /* leave the last known conditions up */ });
}

/**
 * Subscribes to the conditions. `fn` is called with what is already known
 * immediately, and again on every refresh. Returns the unsubscribe.
 */
export function subscribeBandConditions(fn) {
    subscribers.add(fn);
    if (subscribers.size === 1) {
        load();
        timer = setInterval(load, POLL_MS);
    }
    try { fn(states); } catch (err) { console.error('band conditions subscriber threw', err); }

    return () => {
        if (!subscribers.delete(fn)) return;
        if (subscribers.size > 0) return;
        clearInterval(timer);
        timer = null;
        // The last answer is deliberately kept: it is a ten-minute average, so
        // it is still true a moment later, and holding it means a panel coming
        // back paints immediately.
    };
}
