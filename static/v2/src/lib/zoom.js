// Where the spectrum view should sit after a zoom step.
//
// Pure geometry, kept out of RadioContext so it can be tested: the server snaps
// binBandwidth to a fixed ladder, which has made zoom stall in the past, and
// the centring rule below is easy to get subtly wrong in a way nobody notices
// until they are panned away from the dial.

import { MAX_FREQ, MIN_FREQ } from '../radio/constants.js';
import { clamp } from './format.js';

/**
 * Does the view have to move to keep the passband on screen?
 *
 * What has to be visible is what is being demodulated, not the dial — and on
 * the sidebands the passband sits to one side of the dial, so the room needed
 * at the left-hand edge and at the right-hand edge is not the same. In USB at
 * 2.7 kHz you can tune right up against the left edge, because the filter opens
 * rightwards into view; it is the last 2.7 kHz before the right edge that would
 * put it off screen. LSB is the mirror of that, and AM is symmetric because its
 * filter is.
 *
 * This replaced `|freq - centre| > span * 0.35`, which could not say any of
 * that: it moved the view at the same distance whichever way you were going, so
 * on the side the filter does not occupy the outer 15% of the spectrum could not
 * be clicked without the view jumping away from the click.
 *
 * `tuning` is {frequency, bandwidthLow, bandwidthHigh}, the passband edges being
 * signed offsets from the dial as everywhere else.
 */
export function needsRecenter(tuning, centerFreq, span) {
    if (!span || !Number.isFinite(centerFreq)) return false;
    const lo = centerFreq - span / 2;
    const hi = centerFreq + span / 2;

    const low = Math.min(tuning.bandwidthLow, tuning.bandwidthHigh);
    const high = Math.max(tuning.bandwidthLow, tuning.bandwidthHigh);
    // A filter wider than the span — FM at 16 kHz on a 10 kHz view — can never
    // fit, and asking it to would move the view on every tune. There the dial
    // itself is what has to stay visible.
    const fits = Number.isFinite(low) && Number.isFinite(high) && high - low < span;

    return fits
        ? tuning.frequency + low < lo || tuning.frequency + high > hi
        : tuning.frequency < lo || tuning.frequency > hi;
}

// Keeps a whole span inside the band, so neither edge hangs off the end.
export function clampCenter(center, spanHz) {
    const half = spanHz / 2;
    const lo = Math.max(MIN_FREQ, half);
    const hi = Math.max(lo, MAX_FREQ - half);
    return clamp(center, lo, hi);
}

// `aboutHz` is the frequency to zoom about, or null for "no particular point".
//
//   with a point     that frequency is held at the same place on screen. The
//                    wheel passes the frequency under the pointer, which is
//                    what makes wheel zoom feel anchored to the cursor.
//
//   without one      the view centres on `tunedHz`. This is the toolbar's
//                    zoom buttons, where "zoom in" means "show me more detail
//                    around what I am listening to". Holding the old centre
//                    would instead zoom into whatever happened to be in the
//                    middle; anchoring on the dial would be no better when the
//                    dial is off screen, because each step only closes half
//                    the gap and it would never actually arrive.
export function zoomCenter({ centerFreq, span, binCount }, newBinBW, aboutHz, tunedHz) {
    const newSpan = newBinBW * binCount;
    if (aboutHz == null) return clampCenter(tunedHz, newSpan);
    if (!(span > 0)) return clampCenter(centerFreq, newSpan);
    return clampCenter(aboutHz - (aboutHz - centerFreq) * (newSpan / span), newSpan);
}
