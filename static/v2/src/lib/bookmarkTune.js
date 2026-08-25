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
/**
 * Can this receiver actually tune to this bookmark?
 *
 * Bookmarks outlive the receiver's frequency range. An operator who runs their RX888 at
 * 129.6 Msps, saves a 6 m bookmark, and later drops back to 64.8 keeps the record — the
 * server serves it and both panels list it — but the receiver can no longer reach it.
 *
 * Without this, clicking one is worse than a refusal: tuneTo clamps to the band edge, so
 * the dial silently lands on 30 MHz and looks like it worked. Same reasoning as
 * FreqEntry's — "a silent retune to 30 MHz looks like the box working; refusing says the
 * truth".
 *
 * The bounds are arguments, not an import of radio/constants.js, because this module is
 * pure arithmetic and is tested on its own. Callers pass MIN_FREQ/MAX_FREQ; the defaults
 * are what a receiver was before the span became configurable. A caller that forgets is
 * the failure mode to watch for — see RECEIVER_SPAN.md.
 */
export function bookmarkReachable(bookmark, minHz = 10000, maxHz = 30000000) {
    const hz = bookmark && bookmark.frequency;
    return typeof hz === 'number' && Number.isFinite(hz) && hz >= minHz && hz <= maxHz;
}

/** The same question for a marker, which carries its frequency as `freq`. */
export function markerReachable(marker, minHz = 10000, maxHz = 30000000) {
    const hz = marker && marker.freq;
    return typeof hz === 'number' && Number.isFinite(hz) && hz >= minHz && hz <= maxHz;
}

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
