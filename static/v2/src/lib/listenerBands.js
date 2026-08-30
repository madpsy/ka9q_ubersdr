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

// Two listeners closer than this share a dot, as a percentage of the row's
// width. A dot is 9 px and a bar in a dock is 130-200 px wide, so 5% is about
// where two dots would start to overlap — below that they are drawn as one and
// counted, rather than hidden behind each other.
export const CLUSTER_PCT = 5;

const clamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));

/** Where `hz` sits across `min`..`max`, as 0-100, or null if it is outside. */
export function pctOf(hz, min, max) {
    const span = max - min;
    if (!(span > 0) || !Number.isFinite(hz)) return null;
    if (hz < min || hz > max) return null;
    return clamp(((hz - min) / span) * 100, 0, 100);
}

// One row's listeners, left to right, with anything overlapping collapsed.
function cluster(list, min, max) {
    const span = max - min;
    const sorted = list.slice().sort((a, b) => a.frequency - b.frequency);
    const spots = [];

    for (const channel of sorted) {
        const pct = span > 0 ? clamp(((channel.frequency - min) / span) * 100, 0, 100) : 50;
        const last = spots[spots.length - 1];
        // Against the group's leftmost member, not against its running mean: a
        // mean that walks right as members join would swallow a whole band one
        // listener at a time.
        if (last && pct - last.anchor <= CLUSTER_PCT) {
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
 */
export function bandRows(channels, minHz = 10000, maxHz = 30000000) {
    const list = Array.isArray(channels) ? channels.filter((c) => c && c.frequency > 0) : [];
    if (list.length === 0) return [];

    const rows = [];
    const claimed = new Set();

    for (const [name, min, max] of HAM_BANDS) {
        const inBand = list.filter((c) => c.frequency >= min && c.frequency <= max);
        if (inBand.length === 0) continue;
        for (const c of inBand) claimed.add(c);
        rows.push({ name, min, max, hue: BAND_HUE[name] ?? null, spots: cluster(inBand, min, max) });
    }

    const rest = list.filter((c) => !claimed.has(c));
    if (rest.length) {
        // Widen rather than clip: a receiver reporting a listener outside its
        // own advertised range still has to put the dot somewhere, and a dot
        // pinned to the edge lies about where they are.
        const min = Math.min(minHz, ...rest.map((c) => c.frequency));
        const max = Math.max(maxHz, ...rest.map((c) => c.frequency));
        rows.push({ name: OTHER_ROW, min, max, hue: null, spots: cluster(rest, min, max) });
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
 */
export function savedView() {
    try {
        return localStorage.getItem(VIEW_KEY) === BANDS_VIEW ? BANDS_VIEW : LIST_VIEW;
    } catch (e) {
        return LIST_VIEW;
    }
}

export function saveView(view) {
    try {
        localStorage.setItem(VIEW_KEY, view === BANDS_VIEW ? BANDS_VIEW : LIST_VIEW);
    } catch (e) { /* private mode */ }
}
