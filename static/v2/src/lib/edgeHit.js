// Is a pointer on a passband edge, and which one?
//
// Pulled out of SpectrumView so the sizes can be tested rather than eyeballed on
// a phone. The rule it exists to enforce is that a grab zone must never be able
// to swallow the gesture it sits next to:
//
//   * zoomed out to the whole band a 2.7 kHz filter is a fraction of a pixel
//     wide and both edges sit on the dial line, so a grab zone there would take
//     every click meant for tuning. Below `minPx` there is nothing to grab and
//     the wheel — or the top bar's slider — is the way to set a width.
//   * the two zones must not meet, or the middle of the passband belongs to
//     neither edge cleanly and there is nowhere left to tap or to start a pan.
//
// The second of those is enforced here rather than by choosing a `minPx` big
// enough to make a fixed zone safe: the zone is capped at a third of the
// passband, so zone, gap and zone are thirds of it at any width the threshold
// allows. That decoupling is what lets `minPx` come down to the point where the
// zone is too small to aim at, instead of the point where two full-size zones
// stop overlapping — on a phone the latter is a 66 px passband, which a 2.7 kHz
// SSB filter only reaches at the very last rung of the zoom ladder.

/**
 * @param x            pointer position within the row, CSS px from its left.
 * @param width        the row's width in CSS px.
 * @param span         Hz across the whole row.
 * @param centerFreq   Hz at the middle of the row.
 * @param tuning       { frequency, bandwidthLow, bandwidthHigh }.
 * @param grab         how near an edge counts as being on it, CSS px. The most
 *                     the zone is ever allowed to be; a narrow passband gets a
 *                     proportionally narrower one.
 * @param minPx        how wide the passband must be on screen to be grabbed.
 * @returns 'low' | 'high' | null
 */
export function edgeHit(x, width, span, centerFreq, tuning, grab, minPx) {
    if (!width || !span) return null;
    const pxPerHz = width / span;
    const passbandPx = Math.abs(tuning.bandwidthHigh - tuning.bandwidthLow) * pxPerHz;
    if (passbandPx < minPx) return null;

    // Never more than a third each, so there is always as much middle left
    // between the zones as there is zone either side of it.
    const zone = Math.min(grab, passbandPx / 3);

    const left = centerFreq - span / 2;
    const xAt = (hz) => ((tuning.frequency + hz - left) / span) * width;
    const dLow = Math.abs(x - xAt(tuning.bandwidthLow));
    const dHigh = Math.abs(x - xAt(tuning.bandwidthHigh));
    if (Math.min(dLow, dHigh) > zone) return null;
    return dLow <= dHigh ? 'low' : 'high';
}
