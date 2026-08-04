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
];

export const BAND_NAMES = HAM_BANDS.map(([name]) => name);

// Which band a frequency sits in, or null between bands. Inclusive at both
// edges, as v1's active-badge test is.
export function bandForFrequency(hz) {
    for (const [name, min, max] of HAM_BANDS) {
        if (hz >= min && hz <= max) return name;
    }
    return null;
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
    actions.setSpectrumCenter(centre);
    actions.setSpan(Math.max(max - min, MIN_BAND_SPAN));
}
