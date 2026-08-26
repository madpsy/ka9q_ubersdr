// The HF amateur bands, as v1 defines them (app.js `bandRanges`).
//
// Shared rather than owned by one panel: the band buttons colour them by
// conditions, and the voice activity panel has to answer "which band is the
// dial in?" the same way, or the two disagree about which band is current.

// [label, min, max] — v1's ranges verbatim, in v1's order (ascending).
export const HAM_BANDS = [
    ['160m', 1810000, 2000000],
    ['80m', 3500000, 4000000],
    ['60m', 5250000, 5450000],
    ['40m', 7000000, 7300000],
    ['30m', 10100000, 10150000],
    ['20m', 14000000, 14350000],
    ['17m', 18068000, 18168000],
    ['15m', 21000000, 21450000],
    ['12m', 24890000, 24990000],
    ['10m', 28000000, 29700000],
    // 6m is only reachable when the RX888 runs at its full 129.6 MSPS. It stays in this
    // list unconditionally so bandForFrequency can name a 6m frequency correctly whatever
    // the receiver is; the band *buttons* ask bandsInRange instead, so a receiver that
    // cannot get there is not offered a key that would refuse to work.
    ['6m', 50000000, 52000000],
];

export const BAND_NAMES = HAM_BANDS.map(([name]) => name);

/**
 * The bands this receiver can actually tune, for anything that offers them as a choice.
 *
 * A band button for 6m on a 30 MHz receiver is worse than a missing one: tuneToBand goes
 * through setFrequency, which clamps, so pressing it would walk the dial to the band edge
 * and look like it worked.
 *
 * Bounds are arguments rather than an import of radio/constants.js, keeping this module
 * testable on its own like the other pure ones. Callers pass MIN_FREQ/MAX_FREQ; the
 * defaults are what a receiver was before the span became configurable.
 *
 * A band counts as available when it lies entirely inside the range. Half a band is not a
 * band button — the centre it tunes to could be outside what the receiver can reach.
 */
export function bandsInRange(minHz = 10000, maxHz = 30000000) {
    return HAM_BANDS.filter(([, min, max]) => min >= minHz && max <= maxHz);
}

// Which band a frequency sits in, or null between bands. Inclusive at both
// edges, as v1's active-badge test is.
export function bandForFrequency(hz) {
    for (const [name, min, max] of HAM_BANDS) {
        if (hz >= min && hz <= max) return name;
    }
    return null;
}

// ── The 'auto' band filter ───────────────────────────────────────────────────
//
// Several panels offer a band picker whose default follows the dial — the spot lists, the
// voice skimmer — and they have to agree on what that means, which is why it lives here
// beside bandForFrequency rather than in whichever panel wanted it first.
//
// (lib/bandSpectrum.js has its own AUTO_BAND with the same value and a different job: it
// resolves against the bands the *server* records, which is a shorter list than this one
// and can be empty.)
export const AUTO_BAND = 'auto';

/**
 * Which band a picker means right now.
 *
 * Named at length because `bandFilter` is a key in the object v1's CW graph is handed (see
 * compat/cwGraph.js), and a bare one in an object literal is indistinguishable from a use
 * of this — which test/unresolved.js quite reasonably objects to.
 *
 * 'auto' resolves to the band the dial is in, and to 'all' when the dial is somewhere no
 * band covers — most of the shortwave spectrum. That fallback matters: a listener parked on
 * a broadcast station should see a full list rather than an empty one, because "no band"
 * is not a band with nothing in it.
 */
export function resolveBandFilter(choice, dialBand) {
    if (choice !== AUTO_BAND) return choice;
    return dialBand || 'all';
}

// Sort key for a band name: its start frequency, so a list of bands reads up
// the spectrum. Unknown names (an operator's own band, say) sort last, then
// alphabetically among themselves.
export function bandOrder(name) {
    const i = BAND_NAMES.indexOf(name);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

// Frequency range of a named band, or null for a name that is not one of ours.
export function bandRange(name) {
    const b = HAM_BANDS.find(([n]) => n === name);
    return b ? { min: b[1], max: b[2] } : null;
}

// v1 never zooms the spectrum tighter than this when a band is selected, even
// for a band narrower than it (60m, 30m, 12m).
export const MIN_BAND_SPAN = 10000;

// "Take me to that band", as v1's setBand() does it: tune the middle, take the
// band's mode — LSB below 10 MHz, USB above, unless the band declares one — and
// zoom the spectrum to the band's width.
//
// Shared because more than one panel offers the move: the band buttons, and the
// band conditions table, which would otherwise arrive at a different frequency
// for the same band.
export function tuneToBand(actions, min, max, mode) {
    const centre = Math.round((min + max) / 2);
    actions.setMode(mode || (centre < 10000000 ? 'lsb' : 'usb'));
    actions.setFrequency(centre);
    // Centre and span in one message, not setSpectrumCenter followed by setSpan.
    //
    // The two-call form is what this did, and it failed at exactly the moment a band
    // button is most useful — zoomed out. setView clamps the centre so the whole window
    // stays inside the band, and with no span of its own to go on it uses the span you
    // already have: at full zoom-out on a 60 MHz receiver that is 60 MHz wide, so
    // clampCenter's lo and hi both collapse to 30 MHz and *every* band lands on 30 MHz.
    // The setSpan that followed then closed around that, leaving the dial correct and the
    // spectrum showing the middle of the receiver. Zoomed in far enough for the new span
    // to fit, the same code worked — which is what made it look intermittent.
    //
    // One message clamps the centre against the span being asked for rather than the one
    // being left behind. See setSpectrumView in RadioContext, which exists for this.
    actions.setSpectrumView(centre, Math.max(max - min, MIN_BAND_SPAN));
}
