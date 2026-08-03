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
