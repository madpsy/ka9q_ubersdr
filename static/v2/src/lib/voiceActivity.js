// Voice activity: the server's guess at where someone is talking.
//
// The noise floor monitor sweeps each band's FFT for signals with the shape and
// width of speech, and reports an estimated dial frequency, a mode, a
// confidence and — when the DX cluster has a spot near that frequency — the
// callsign it probably belongs to.
//
// This mirrors v1's static/voice-activity-service.js: one poll of the
// all-bands endpoint, from which the current band's slice is derived locally.
// Per-band requests would share the same rate-limit bucket for no benefit, and
// the all-bands payload is what the popup page shows anyway.
//
// Pure helpers live here (rather than in the panel) so they are testable: the
// grouping and the dial-frequency fallback both have edge cases that only show
// up on a live band.

import { bandOrder } from './bands.js';
import { feedInterval, setFeedsAllowed } from './serverFeeds.js';

// v1's filter, and the same 5 s cadence its service polls at.
export const MIN_CONFIDENCE = 0.7;
export const POLL_MS = 5000;

export function endpoint(minConfidence = MIN_CONFIDENCE) {
    return `/api/noisefloor/voice-activity/all?min_confidence=${minConfidence}`;
}

// Where clicking an entry should tune to. The detector reports the signal's
// span and, separately, the dial frequency a receiver would use to hear it —
// which is not the middle of the span, because SSB is one-sided. v1 falls back
// to the lower edge when the estimate is missing, so this does too.
export function dialFreq(a) {
    return (a && (a.estimated_dial_freq || a.start_freq)) || 0;
}

// v1's confidence colour bands (voice-activity.html renderActivityRow).
export function confidenceTone(confidence) {
    const pct = (confidence || 0) * 100;
    if (pct >= 70) return 'high';
    if (pct >= 50) return 'medium';
    if (pct >= 30) return 'low';
    return '';
}

// Turns the server's { bandName: [activity] } map into a list of groups, in
// frequency order rather than v1's alphabetical one — "10m, 12m, 160m, 17m"
// reads as a sorting accident, and the bands are a spectrum.
//
// Each activity is tagged with its band: the map is keyed by band but the
// objects inside carry no band of their own, and a flat list needs it.
export function groupByBand(bands) {
    const out = [];
    for (const name of Object.keys(bands || {})) {
        const list = bands[name];
        if (!Array.isArray(list) || list.length === 0) continue;
        out.push({ band: name, activities: list.map((a) => ({ ...a, band: name })) });
    }
    out.sort((a, b) => bandOrder(a.band) - bandOrder(b.band) || a.band.localeCompare(b.band));
    return out;
}

// Every activity across every band, in the same order the groups are in.
export function flatten(groups) {
    const out = [];
    for (const g of groups) out.push(...g.activities);
    return out;
}

export function countActivities(groups) {
    let n = 0;
    for (const g of groups) n += g.activities.length;
    return n;
}

// What a marker says: the spotted callsign when the cluster gave us one,
// otherwise "Voice" with the band, so a zoomed-out view showing several bands
// can still tell them apart. v1's activityLabel.
export function activityLabel(a) {
    if (!a) return 'Voice';
    return a.dx_callsign || `Voice${a.band ? ` ${a.band}` : ''}`;
}

// --- shared polling ---------------------------------------------------------
//
// One poll for the whole app, as v1's voice-activity-service.js is: the panel
// and the marker bar both want this, the endpoint is rate limited per IP, and
// two independent 5 s loops would burn that budget for the same bytes.
//
// Lazy in both directions — nothing is fetched until something subscribes, and
// polling stops when the last subscriber goes. That matters because the panel
// is unmounted while its section is collapsed and the markers are behind a
// toggle, so the common case is nobody watching.

const subscribers = new Set();
let timer = null;
let latest = null;
let inFlight = false;

function emit(state) {
    latest = state;
    for (const fn of subscribers) {
        try { fn(state); } catch (err) { console.error('voice activity subscriber threw', err); }
    }
}

function load() {
    if (inFlight) return;
    inFlight = true;
    fetch(endpoint())
        .then((r) => {
            // Rate limited: keep what we have. The detector holds each
            // frequency for 90 s after it was last seen, so a missed poll is
            // not the signal going away.
            if (r.status === 429) return null;
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        })
        .then((d) => {
            if (!d) return;
            const groups = groupByBand(d.bands);
            emit({ groups, activities: flatten(groups), error: '', at: Date.now() });
        })
        .catch((err) => {
            // Keep the last good data and report alongside it, rather than
            // blanking the panel and the markers on one failed request.
            emit({
                groups: (latest && latest.groups) || [],
                activities: (latest && latest.activities) || [],
                error: err.message || String(err),
                at: latest ? latest.at : 0,
            });
        })
        .finally(() => { inFlight = false; });
}

export function subscribeVoiceActivity(fn) {
    subscribers.add(fn);
    // Replay, so a panel opening mid-cycle renders immediately instead of
    // showing "Loading…" for up to five seconds.
    if (latest) {
        try { fn(latest); } catch (err) { console.error('voice activity subscriber threw', err); }
    }
    if (timer === null) {
        timer = feedInterval(load, POLL_MS);
    }
    return () => {
        subscribers.delete(fn);
        if (subscribers.size === 0 && timer !== null) {
            timer();
            timer = null;
        }
    };
}

// Test seam.
export function _resetVoiceActivity() {
    // A store under test polls: the feed gate is the receiver's business, it
    // has its own tests, and every case here is about this module's refcounting
    // rather than about being switched off. See lib/serverFeeds.js.
    setFeedsAllowed(true);
    subscribers.clear();
    if (timer !== null) timer();
    timer = null;
    latest = null;
    inFlight = false;
}
