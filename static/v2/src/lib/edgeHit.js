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
//   * the two zones must not meet. `minPx` has to leave room between them, or
//     the middle of the passband belongs to neither edge cleanly and there is
//     nowhere left to tap or to start a pan.

/**
 * @param x            pointer position within the row, CSS px from its left.
 * @param width        the row's width in CSS px.
 * @param span         Hz across the whole row.
 * @param centerFreq   Hz at the middle of the row.
 * @param tuning       { frequency, bandwidthLow, bandwidthHigh }.
 * @param grab         how near an edge counts as being on it, CSS px.
 * @param minPx        how wide the passband must be on screen to be grabbed.
 * @returns 'low' | 'high' | null
 */
export function edgeHit(x, width, span, centerFreq, tuning, grab, minPx) {
    if (!width || !span) return null;
    const pxPerHz = width / span;
    if (Math.abs(tuning.bandwidthHigh - tuning.bandwidthLow) * pxPerHz < minPx) return null;

    const left = centerFreq - span / 2;
    const xAt = (hz) => ((tuning.frequency + hz - left) / span) * width;
    const dLow = Math.abs(x - xAt(tuning.bandwidthLow));
    const dHigh = Math.abs(x - xAt(tuning.bandwidthHigh));
    if (Math.min(dLow, dHigh) > grab) return null;
    return dLow <= dHigh ? 'low' : 'high';
}
