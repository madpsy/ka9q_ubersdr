// What to tune when a bookmark is clicked.
//
// Server bookmarks (/api/bookmarks, from the receiver's config.yaml) and local ones (v1's
// IndexedDB store) are the same record: name, frequency, mode, and an optional passband as
// `bandwidth_low` / `bandwidth_high`. Both halves of the interface show both kinds, and the
// v1 UI honours the passband on either — so anything in v2 that tunes to a bookmark has to
// mean the same thing by one.
//
// It did not. The local bookmarks panel applied the passband, and the other three paths —
// the server bookmarks panel, a pill on the marker bar, stepping onto a bookmark with
// marker navigation — silently opened the mode's default filter instead. Which is a real
// difference and not a cosmetic one: a bookmark on a narrow CW signal, or on one of the
// KiwiSDR passbands an import carries, is *about* its filter. The frequency without it is
// the wrong station.
//
// So this is the one answer, and everything asks it here.

/**
 * A bookmark as `actions.tuneTo` wants it.
 *
 * Frequency, mode and passband go in one call rather than three actions, deliberately: a
 * mode change resets the passband, so setMode-then-setBandwidth walks the receiver through
 * an intermediate state and sends two tunes. v1 has a long comment about the audible
 * stutter that produces on a mode switch; tuneTo exists so we do not reproduce it.
 *
 * An absent or half-written passband is left out entirely rather than passed as null, so
 * tuneTo applies the mode's own — one edge is not a filter, and a bookmark carrying only a
 * low edge tells us nothing about the high one. A mode the receiver does not have (`drm`,
 * `iq` and friends, which KiwiSDR imports bring in) is dropped the same way, and tuneTo
 * keeps the current mode: v1 skips the mode change for exactly those and says so in a log
 * line.
 */
export function bookmarkTarget(bookmark) {
    if (!bookmark || !(bookmark.frequency > 0)) return null;
    const mode = String(bookmark.mode || '').toLowerCase();
    const low = bookmark.bandwidth_low;
    const high = bookmark.bandwidth_high;
    const pair = typeof low === 'number' && typeof high === 'number' && low < high;
    return {
        frequency: Math.round(bookmark.frequency),
        // Undefined rather than '' — tuneTo tests the mode against its table, and an empty
        // string would be as good as a missing one, but this way the two are the same
        // absence.
        ...(mode ? { mode } : {}),
        ...(pair ? { bandwidthLow: low, bandwidthHigh: high } : {}),
    };
}

/**
 * The same thing for a marker, which carries the pair already flattened — see
 * collectMarkers in lib/markerNav.js. Kept beside bookmarkTarget because it is the same
 * question about the same records, arriving in a different shape.
 */
export function markerTarget(marker) {
    if (!marker || !(marker.freq > 0)) return null;
    const pair = typeof marker.low === 'number' && typeof marker.high === 'number'
        && marker.low < marker.high;
    return {
        frequency: Math.round(marker.freq),
        ...(marker.mode ? { mode: marker.mode } : {}),
        ...(pair ? { bandwidthLow: marker.low, bandwidthHigh: marker.high } : {}),
    };
}
