// What an FT8 signal-to-noise reading means, and how a band button reads it.
//
// The buckets and the wording only — no state, no timer, no request. The
// reading itself is the noise floor monitor's latest measurement, which
// lib/bandNoise.js polls once for everyone who wants it: the Quick bands keys,
// the Multipad's band row and the Bands panel are three views of one answer, so
// they cannot disagree about a band and cost one request between them however
// many of them are open.
//
// It was its own poll of /api/noisefloor/aggregate — a ten-minute average of
// ft8_snr for the ten amateur bands — which was a second request on a second
// timer for a figure /api/noisefloor/latest already carries, and a second
// opinion about the same band whenever a bucket boundary fell between the
// average and the reading the Bands panel was showing beside it. The window is
// now the monitor's own minute rather than ten of them, so a band on a
// threshold changes colour a little more readily than v1's buttons do; what it
// says is the same reading the Bands panel is showing.
//
// The thresholds are v1's (static/bands_state.js and app.js), so both frontends
// call the same band the same colour.

/** v1's buckets. */
export function classify(snr) {
    if (snr < 6) return 'POOR';
    if (snr < 20) return 'FAIR';
    if (snr < 30) return 'GOOD';
    return 'EXCELLENT';
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
