// Where the spectrum view should sit after a zoom step.
//
// Pure geometry, kept out of RadioContext so it can be tested: the server snaps
// binBandwidth to a fixed ladder, which has made zoom stall in the past, and
// the centring rule below is easy to get subtly wrong in a way nobody notices
// until they are panned away from the dial.

import { MAX_FREQ, MIN_FREQ } from '../radio/constants.js';
import { clamp } from './format.js';

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
