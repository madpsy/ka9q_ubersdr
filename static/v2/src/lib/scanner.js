// Scanning: how long to sit on a channel, and which channels there are.
//
// Two panels scan. The VFOs panel steps between the four slots; the Scanner
// panel steps between markers — spots, voice activity, bookmarks — and both stop
// on the first channel the squelch opens on. The stopping is the same judgement
// in both, made against the same timings, so the timings live here rather than
// in whichever panel wanted them first: a dwell that is right for one scan is
// right for the other, and two copies would drift the moment one was tuned.
//
// The target list is the part only the Scanner needs, and it is pure — hand it
// the markers and it hands back what to step through. Nothing here fetches,
// subscribes or reads the DOM.

import { isIQ } from '../radio/constants.js';
import { bandForFrequency, bandRange } from './bands.js';
import { MARKER_TOLERANCE_HZ } from './markerNav.js';

// How long a scan sits on each channel before moving on. Short enough that a
// handful come round in a second or two, long enough that the server's audio has
// arrived and been metered — the gate is judged on packets, not on the tune.
export const SCAN_DWELL_MS = 250;

// What a hop costs when it also changes mode, which is a different kind of hop.
//
// A mode change makes the server reload radiod's preset, which rebuilds the
// filter and restarts the demodulator, and the server holds the audio gate shut
// until radiod confirms the new channel — around a fifth of a second in which
// there is deliberately nothing to hear. Judging a channel inside that window
// finds silence whoever is on it, so a busy one would be stepped over rather
// than stopped on. These wait it out and then leave a run of packets to judge.
export const SCAN_MODE_DWELL_MS = 600;
export const SCAN_MODE_SETTLE_MS = 350;

// After a hop, the packets already in flight were produced on the channel we
// just left, so the gate they open is the old one's, not this one's. A signal on
// the previous channel would otherwise stop the scan on the next, one hop late
// and every time. Judged from a moment after the tune instead — well inside a
// 250 ms dwell, so there is still a run of packets left to hear this channel on.
export const SCAN_SETTLE_MS = 100;

/**
 * The channels a marker scan should step through, in frequency order.
 *
 * `markers` is lib/markerNav.js's collected list — the same one the prev/next
 * buttons search, so the Scanner and the Markers panel cannot disagree about
 * what is out there.
 *
 * Three things happen to it:
 *
 *   - kinds nobody asked for are dropped. The feeds behind them are already
 *     gated on the same selection (see useMarkerNav), so this is belt and
 *     braces rather than the filter — but a marker arriving from a feed that has
 *     not yet unsubscribed would otherwise be scanned to.
 *
 *   - `bandOnly` keeps it inside the band the dial is in. Outside every ham band
 *     — which is most of the shortwave spectrum — that resolves to no limit at
 *     all rather than to an empty list, which is the same answer
 *     resolveBandFilter gives and for the same reason: "no band" is not a band
 *     with nothing in it, and a listener parked on a broadcast station asking to
 *     scan should get a scan.
 *
 *   - `ignoreIQ` drops markers that name a quadrature mode. Tuning to one is not
 *     a hop at all: switching into IQ is confirmed rather than selected — it
 *     costs the receiver's owner six times the bandwidth and takes the audio
 *     chain, the squelch and the S-meter away — so the tune is swallowed and a
 *     dialog goes up instead. In the middle of a scan that is a modal nobody
 *     asked for over a hop that never happened, and if it were answered the scan
 *     would stop dead the next tick for want of a squelch. A KiwiSDR import is
 *     where these come from; see bookmarkTarget.
 *
 *   - anything the dial cannot tell apart is folded together. A voice detection
 *     and the skimmer's confirmation of it land within a few tens of hertz of
 *     each other, and stepping to both means two dwells, two mode reloads and
 *     two chances to stop, on what is one station. The survivor is the
 *     higher-priority marker — a named sighting over a bare detection, a live
 *     spot over a bookmark — which is the same precedence findMarkers applies to
 *     the marker under the dial.
 */
export function scanTargets(markers, { types, bandOnly, dialHz, ignoreIQ } = {}) {
    const allow = Array.isArray(types) ? new Set(types) : null;
    const range = bandOnly ? bandRange(bandForFrequency(dialHz)) : null;

    const wanted = [];
    for (const m of markers || []) {
        if (!m || !(m.freq > 0)) continue;
        if (allow && !allow.has(m.type)) continue;
        if (range && (m.freq < range.min || m.freq > range.max)) continue;
        // A marker with no mode of its own is tuned in whatever is live, so it
        // is never an IQ hop however this is set.
        if (ignoreIQ && m.mode && isIQ(m.mode)) continue;
        wanted.push(m);
    }
    // Frequency order, and the better marker first where two share one — so the
    // fold below keeps it without having to look back.
    wanted.sort((a, b) => (a.freq - b.freq) || ((b.priority || 0) - (a.priority || 0)));

    const kept = [];
    for (const m of wanted) {
        const last = kept[kept.length - 1];
        if (last && m.freq - last.freq <= MARKER_TOLERANCE_HZ) {
            if ((m.priority || 0) > (last.priority || 0)) kept[kept.length - 1] = m;
            continue;
        }
        kept.push(m);
    }
    return kept;
}

/**
 * The next channel above `afterHz`, wrapping to the bottom of the list.
 *
 * Taken by frequency rather than by index because the list is rebuilt every time
 * a feed updates — a spot arriving mid-scan renumbers everything after it, and
 * an index would jump the scan somewhere it has already been, or past a channel
 * it has not. A frequency survives that: whatever the list now holds, the scan
 * carries on from where it had got to.
 */
export function nextScanMarker(list, afterHz) {
    if (!list || !list.length) return null;
    for (const m of list) {
        if (m.freq > afterHz) return m;
    }
    return list[0];
}
