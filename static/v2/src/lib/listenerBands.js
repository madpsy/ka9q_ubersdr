// Where the listeners are, rather than who they are — the Listeners panel's
// second view.
//
// channels-map.html draws this at the foot of the map: one row per amateur band
// somebody is in, every listener a dot at its place across the band. This is
// the same picture cut down to a dock column, which means dropping the three
// things that make the map's version wide — the per-dot username labels, the
// frequency scale under each bar, and the vertical tiering of listeners on the
// same frequency. Two dots closer together than a dot is wide become one dot
// carrying a count instead, so a row is one dot high whatever is happening on
// the band.
//
// Pure: the panel hands it the channel list and gets back percentages. Nothing
// here touches the DOM, which is the only reason the geometry can be tested at
// all.

import { HAM_BANDS } from './bands.js';
import { tunable } from './listeners.js';

// One hue per band, in degrees, close to the colours channels-map.html paints
// its rows with. Hues rather than the map's hex, because this view has to work
// on a light background too: the panel resolves them through hsl() at a
// lightness the current theme picks, and 60m's gold at #ffd700 is invisible on
// white.
//
// 12m and 6m are moved off the map's pink and blueviolet — beside their
// neighbours at a dock's width the map's choices read as the same colour.
export const BAND_HUE = {
    '160m': 9,
    '80m': 39,
    '60m': 51,
    '40m': 120,
    '30m': 195,
    '20m': 225,
    '17m': 271,
    '15m': 328,
    '12m': 300,
    '10m': 348,
    '6m': 165,
};

// Everyone who is not in an amateur band — broadcast, utility, the aviation
// bands — on one row across the receiver's whole range.
//
// The map simply drops them, which it can afford to: it still has the pins.
// Here the panel has just told you there are six other listeners, and a picture
// showing two of them would read as a bug rather than as a filter.
export const OTHER_ROW = 'Other';

const clamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));

// Two dots are separate dots only if their centres are this far apart in
// pixels. A dot is 9 px, so anything under about 12 leaves them touching, and
// the ones that tune carry a few pixels of slop around them besides.
export const MIN_DOT_GAP_PX = 12;

// The threshold before the bar has been measured, as a percentage of it. Only
// the first render and the tests get here — see gapPct.
export const CLUSTER_PCT = 5;

/**
 * The cluster threshold for a bar this wide, as a percentage of its width.
 *
 * Pixels rather than a fixed percentage because the dock is resizable across a
 * factor of two and a half (220-560 px, LayoutContext), and a percentage is
 * wrong at both ends of that: 5% is 7 px in the narrowest dock, where dots
 * overlap, and 24 px in the widest, where two listeners a hundred kilohertz
 * apart are drawn as one for no reason. The bar is measured and the threshold
 * follows it, so a dot means the same thing at every width.
 *
 * Bounded either side: a bar that has not been laid out yet measures 0, and a
 * threshold of a quarter of the band is as coarse as this is allowed to get.
 */
export function gapPct(barPx) {
    if (!(barPx > 0)) return CLUSTER_PCT;
    return clamp((MIN_DOT_GAP_PX / barPx) * 100, 0.5, 25);
}

/** Where `hz` sits across `min`..`max`, as 0-100, or null if it is outside. */
export function pctOf(hz, min, max) {
    const span = max - min;
    if (!(span > 0) || !Number.isFinite(hz)) return null;
    if (hz < min || hz > max) return null;
    return clamp(((hz - min) / span) * 100, 0, 100);
}

// One row's listeners, left to right, with anything overlapping collapsed.
function cluster(list, min, max, threshold) {
    const span = max - min;
    const sorted = list.slice().sort((a, b) => a.frequency - b.frequency);
    const spots = [];

    for (const channel of sorted) {
        const pct = span > 0 ? clamp(((channel.frequency - min) / span) * 100, 0, 100) : 50;
        const last = spots[spots.length - 1];
        // Against the group's leftmost member, not against its running mean: a
        // mean that walks right as members join would swallow a whole band one
        // listener at a time.
        if (last && pct - last.anchor <= threshold) {
            last.channels.push(channel);
            last.sum += pct;
        } else {
            spots.push({ anchor: pct, sum: pct, channels: [channel] });
        }
    }

    return spots.map((s, i) => ({
        key: `${i}-${s.channels[0].frequency}`,
        // The middle of what it stands for, so a dot sits on its listeners
        // rather than on the first of them.
        pct: s.sum / s.channels.length,
        channels: s.channels,
        you: s.channels.some((c) => c.you),
        // What clicking it tunes to. Null when the dot is only you, or only IQ
        // channels — see listeners.tunable.
        tune: s.channels.find(tunable) || null,
    }));
}

/**
 * The rows to draw, in band order, for the channels the server reported.
 *
 * `minHz`/`maxHz` bound the catch-all row only; the amateur rows are their own
 * width whatever the receiver can reach. A band nobody is in gets no row: ten
 * empty bars would fill the panel with the one thing it has nothing to say
 * about.
 *
 * `threshold` is how close two listeners have to be to share a dot, as a
 * percentage of the row — gapPct(barWidth), or the default for a caller with
 * nothing measured. It is what bounds the work: however many listeners the
 * server reports, a row holds at most 100/threshold dots and the panel holds at
 * most one row per band, so both the height and the element count are capped by
 * the geometry rather than by how busy the receiver is.
 */
export function bandRows(channels, minHz = 10000, maxHz = 30000000, threshold = CLUSTER_PCT) {
    const list = Array.isArray(channels) ? channels.filter((c) => c && c.frequency > 0) : [];
    if (list.length === 0) return [];

    const rows = [];
    const claimed = new Set();

    for (const [name, min, max] of HAM_BANDS) {
        const inBand = list.filter((c) => c.frequency >= min && c.frequency <= max);
        if (inBand.length === 0) continue;
        for (const c of inBand) claimed.add(c);
        rows.push({ name, min, max, hue: BAND_HUE[name] ?? null, spots: cluster(inBand, min, max, threshold) });
    }

    const rest = list.filter((c) => !claimed.has(c));
    if (rest.length) {
        // Widen rather than clip: a receiver reporting a listener outside its
        // own advertised range still has to put the dot somewhere, and a dot
        // pinned to the edge lies about where they are.
        const min = Math.min(minHz, ...rest.map((c) => c.frequency));
        const max = Math.max(maxHz, ...rest.map((c) => c.frequency));
        rows.push({ name: OTHER_ROW, min, max, hue: null, spots: cluster(rest, min, max, threshold) });
    }

    return rows;
}

// ── Which view the panel opens on ────────────────────────────────────────────

export const LIST_VIEW = 'list';
export const BANDS_VIEW = 'bands';

const VIEW_KEY = 'ubersdr.v2.listeners.view';

/**
 * Remembered for the reason the band stats metric is: an operator who watches
 * the bands watches them every session, and the panel is opened often enough
 * that having to switch it every time would be worse than not having the view.
 *
 * The bands are what the panel opens on. "Who is here" is a list of names that
 * mostly are not names — a chat username is optional and usually absent — while
 * "where is everybody" is answered at a glance and is the reason to open the
 * panel at all. Only an explicit choice of the list is stored as one; anything
 * else, including a value from a version that stored something else, opens the
 * bands.
 */
export function savedView() {
    try {
        return localStorage.getItem(VIEW_KEY) === LIST_VIEW ? LIST_VIEW : BANDS_VIEW;
    } catch (e) {
        return BANDS_VIEW;
    }
}

export function saveView(view) {
    try {
        localStorage.setItem(VIEW_KEY, view === LIST_VIEW ? LIST_VIEW : BANDS_VIEW);
    } catch (e) { /* private mode */ }
}
