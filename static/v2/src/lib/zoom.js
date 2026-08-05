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

// ---------------------------------------------------------------------------
// The zoom as a ladder of rungs.
//
// zoomIn/zoomOut halve or double and then read back whatever the server made of
// it, which is all a button needs: it never has to know where it will land. A
// control that *draws* the ladder — the Multipad's zoom barrel — does. It has to
// name the rung in force, the ones either side of it, and where the ladder ends,
// a detent at a time.
//
// So the rungs are the views that actually exist, and there are only two rules
// making them (both in user_spectrum_websocket.go):
//
//   Above BIN_BW_PASSTHROUGH the server takes a request as given, so the wide
//   end of the ladder is exactly what halving produces.
//
//   At or below it every request is snapped to BIN_BW_LADDER, so from there down
//   the rungs are that list and nothing between.
//
// Powers of two below the full span — which is what this used to assume — are
// right for the first two rungs and drift after that: on a 1024-bin receiver the
// real ladder runs 30 M, 15 M, 5.12 M, 2.048 M … and its floor sits 11.5
// doublings down, so flooring that to 11 left the last rung, the one the zoom
// buttons and a pinch both reach, off the drum entirely.

// Descending, as the server's if-chain snaps them.
export const BIN_BW_LADDER = [5000, 2000, 1000, 500, 300, 200, 100, 50, 20, 10, 5, 2, 1, 0.5];

// Above this a request is passed through untouched — the default full-span
// bandwidth (30 MHz / bin_count) is far above it, which is the case it exists
// for.
export const BIN_BW_PASSTHROUGH = 7500;

/**
 * Every span the zoom controls can actually produce, widest first.
 *
 * `fullBinBW` and `binCount` are the server's defaults (`defaultBinBandwidth`,
 * `defaultBinCount`); `minBinBW` is the floor, which is
 * SpectrumConnection.minBinBandwidthForUI. The bin count is deliberately the
 * default rather than the live one: the server's deep-zoom path reduces it, and
 * the ladder must not change shape underneath a drum that is being spun.
 */
export function zoomLadder(fullBinBW, binCount, minBinBW) {
    if (!(fullBinBW > 0) || !(binCount > 0)) return [];
    const floor = Math.max(minBinBW > 0 ? minBinBW : 0.5, 0.5);
    const bws = [];
    for (let bw = fullBinBW; bw > BIN_BW_PASSTHROUGH && bw >= floor; bw /= 2) bws.push(bw);
    for (const bw of BIN_BW_LADDER) {
        if (bw < floor) break;                                  // the list descends
        if (bw > fullBinBW) continue;                           // wider than this receiver's full view
        if (bws.length && bw >= bws[bws.length - 1]) continue;
        bws.push(bw);
    }
    // A receiver whose full span is already at the floor still has one view.
    if (!bws.length) bws.push(fullBinBW);
    return bws.map((bw) => bw * binCount);
}

/**
 * Which rung a span is on: the nearest, measured as a ratio.
 *
 * Ratios rather than differences, because the ladder is geometric — 20 kHz is
 * nearer 20.48 than 10.24 by either measure, but at the wide end a difference
 * would put anything below about 17 MHz on the 5 MHz rung.
 */
export function rungOfSpan(span, ladder) {
    if (!ladder || !ladder.length || !(span > 0)) return 0;
    let best = 0;
    let bestErr = Infinity;
    for (let i = 0; i < ladder.length; i++) {
        const err = Math.abs(Math.log(ladder[i] / span));
        if (err < bestErr) { bestErr = err; best = i; }
    }
    return best;
}

/** The span at a rung, clamped to the ends of the ladder. */
export function spanAtRung(rung, ladder) {
    if (!ladder || !ladder.length) return 0;
    return ladder[clamp(Math.round(rung), 0, ladder.length - 1)];
}

/**
 * The spectrum view to open with: where this browser last had it.
 *
 * The zoom is resumed as the bin bandwidth rather than a span, because that is
 * what the server quantises and what the socket takes — a span would be rounded
 * to the nearest rung on every reconnect and drift a little further each time.
 *
 * The centre is only resumed if the dial would be inside it. A link carrying
 * `?freq=` opened by someone with a saved view elsewhere would otherwise come
 * up showing 20 m with the dial on 40 m and nothing on screen to explain it;
 * keeping the zoom and centring it on the dial is what they meant by following
 * the link. Same rule the auto-recentre uses, so the two agree.
 *
 * Both values or neither: the server applies whichever of the two it is given
 * and keeps what it had for the other, so a centre without a zoom lands on the
 * full-span default and asks for a 30 MHz window somewhere it cannot exist.
 */
export function resumeView(saved, tuning) {
    const bw = Number(saved.spectrumBinBandwidth);
    const centre = Number(saved.spectrumCenter);
    if (!(bw > 0) || !(centre > 0)) return {};
    const span = Number(saved.spectrumSpan);
    const showsDial = span > 0 && !needsRecenter(tuning, centre, span);
    return { frequency: showsDial ? centre : tuning.frequency, binBandwidth: bw };
}
